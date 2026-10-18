"""Authlib code+PKCE and ID-token verification with fixed bounded egress."""
import asyncio
import math

import httpx2
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.oidc.core import CodeIDToken
from joserfc import jwt
from joserfc.jwk import KeySet
from joserfc.jws import JWSRegistry

from .errors import ApiError

RESPONSE_LIMIT = 65536


class CappedStream(httpx2.AsyncByteStream):
    def __init__(self, stream):
        self.stream = stream

    async def __aiter__(self):
        count = 0
        async for chunk in self.stream:
            count += len(chunk)
            if count > RESPONSE_LIMIT:
                raise ApiError('DEPENDENCY_UNAVAILABLE')
            yield chunk

    async def aclose(self):
        await self.stream.aclose()


class OidcTransport(httpx2.AsyncBaseTransport):
    def __init__(self, settings, inner):
        self.inner = inner
        self.token = httpx2.URL(settings.token_endpoint)
        self.jwks = httpx2.URL(settings.jwks_uri)
        self.token_status = None

    async def handle_async_request(self, request):
        if (request.method, request.url) not in (('POST', self.token), ('GET', self.jwks)):
            raise ApiError('DEPENDENCY_UNAVAILABLE')
        response = await self.inner.handle_async_request(request)
        if request.url == self.token and request.method == 'POST':
            self.token_status = response.status_code
        try:
            encoding = response.headers.get('content-encoding', 'identity').strip().lower()
            if encoding != 'identity':
                raise ValueError()
            length = response.headers.get('content-length')
            if length is not None and (not length.isdigit() or int(length) > RESPONSE_LIMIT):
                raise ValueError()
            if not (200 <= response.status_code < 300 or (request.url == self.token and response.status_code in (400, 401))):
                raise ValueError()
            return httpx2.Response(response.status_code, headers=response.headers,
                                   stream=CappedStream(response.stream), extensions=response.extensions, request=request)
        except Exception:
            await response.aclose()
            raise ApiError('DEPENDENCY_UNAVAILABLE') from None

    async def aclose(self):
        await self.inner.aclose()


def oauth_client(settings, transport_factory=None):
    inner = transport_factory() if transport_factory else httpx2.AsyncHTTPTransport(
        verify=True, trust_env=False, proxy=None, retries=0)
    guard = OidcTransport(settings, inner)
    client = AsyncOAuth2Client(
        settings.client_id, settings.client_secret, token_endpoint_auth_method=settings.client_auth_method,
        redirect_uri=settings.redirect_uri, scope='openid', code_challenge_method='S256',
        transport=guard, trust_env=False, proxy=None,
        follow_redirects=False, max_redirects=0, timeout=5,
        headers={'Accept-Encoding': 'identity'}, limits=httpx2.Limits(max_connections=4, max_keepalive_connections=0))
    client.ifpmic_guard = guard
    return client


async def authorization_url(settings, *, state, nonce, verifier, transport_factory=None):
    async with oauth_client(settings, transport_factory) as client:
        url, _ = client.create_authorization_url(settings.authorization_endpoint, state=state,
                                                 code_verifier=verifier, nonce=nonce)
        return url


def verify_token(settings, token, jwks, *, nonce, now):
    try:
        if not isinstance(token, dict) or not isinstance(token.get('id_token'), str):
            raise ValueError()
        if not isinstance(jwks, dict) or not isinstance(jwks.get('keys'), list) or not 1 <= len(jwks['keys']) <= 32:
            raise ValueError()
        for key in jwks['keys']:
            if not isinstance(key, dict) or key.get('kty') not in ('RSA', 'EC') or set(key) & {'d', 'p', 'q', 'dp', 'dq', 'qi', 'k'}:
                raise ValueError()
        decoded = jwt.decode(token['id_token'], KeySet.import_key_set(jwks),
                             registry=JWSRegistry(algorithms=list(settings.signing_algorithms), strict_check_header=True))
        claims = decoded.claims
        if set(decoded.header) - {'alg', 'kid', 'typ'}:
            raise ValueError()
        for field in ('exp', 'iat', 'nbf'):
            value = claims.get(field)
            if field == 'nbf' and field not in claims:
                continue
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError()
        if claims['exp'] <= now or claims['iat'] > now or claims.get('nbf', now) > now:
            raise ValueError()
        subject = claims.get('sub')
        if not isinstance(subject, str) or not subject or any(ord(c) == 0 or 0xD800 <= ord(c) <= 0xDFFF for c in subject):
            raise ValueError()
        audience = claims.get('aud')
        values = [audience] if isinstance(audience, str) else audience
        if (not isinstance(values, list) or not values or any(not isinstance(v, str) or not v for v in values) or
                len(set(values)) != len(values) or settings.client_id not in values):
            raise ValueError()
        if (len(values) > 1 and claims.get('azp') != settings.client_id) or ('azp' in claims and claims['azp'] != settings.client_id):
            raise ValueError()
        if 'at_hash' in claims:
            access = token.get('access_token')
            if (not isinstance(claims['at_hash'], str) or not claims['at_hash'] or
                    not isinstance(access, str) or not access or not access.isascii()):
                raise ValueError()
        validation = CodeIDToken(claims, decoded.header,
                                 {'iss': {'essential': True, 'value': settings.issuer},
                                  'aud': {'essential': True, 'value': settings.client_id}},
                                 {'nonce': nonce, 'client_id': settings.client_id, 'access_token': token.get('access_token')})
        validation.validate(now=now, leeway=0)
        return subject
    except Exception:
        raise ApiError('AUTH_REQUIRED') from None


async def exchange(settings, *, code, verifier, nonce, now, transport_factory=None):
    client = None
    try:
        async with asyncio.timeout(10):
            async with oauth_client(settings, transport_factory) as client:
                token = await client.fetch_token(settings.token_endpoint, grant_type='authorization_code', code=code,
                                                 code_verifier=verifier, redirect_uri=settings.redirect_uri)
                response = await client.request('GET', settings.jwks_uri, withhold_token=True)
                jwks = response.json()
        return verify_token(settings, token, jwks, nonce=nonce, now=now() if callable(now) else now)
    except ApiError:
        raise
    except Exception as error:
        # Authlib OAuth protocol errors carry an error code; never expose their
        # description/URI or a network exception containing a private request.
        if (getattr(error, 'error', None) == 'invalid_grant' and client is not None and
                client.ifpmic_guard.token_status in (400, 401)):
            raise ApiError('AUTH_REQUIRED') from None
        raise ApiError('DEPENDENCY_UNAVAILABLE') from None
