"""Explicit private service settings; importing this module performs no IO."""
from dataclasses import dataclass
import base64
import json
import os
import stat
from pathlib import Path
from urllib.parse import urlsplit


class SettingsError(Exception):
    code = 'SETTINGS_INVALID'

    def __init__(self):
        super().__init__(self.code)


def url_origin(value):
    if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
        raise SettingsError()
    parts = urlsplit(value)
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None or
            parts.password is not None or '?' in value or '#' in value or '\\' in value):
        raise SettingsError()
    port = parts.port
    host = f'[{parts.hostname}]' if ':' in parts.hostname else parts.hostname
    if port and port != (443 if parts.scheme == 'https' else 80):
        host += f':{port}'
    return f'{parts.scheme}://{host}'


@dataclass(frozen=True, repr=False, kw_only=True)
class Settings:
    mode: str
    api_origin: str
    issuer: str
    client_id: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str
    redirect_uri: str
    post_login_url: str
    allowed_ui_origins: tuple[str, ...]
    csrf_key: bytes
    database_dsn: str | None = None
    client_secret: str | None = None
    client_auth_method: str = 'client_secret_basic'
    signing_algorithms: tuple[str, ...] = ('RS256',)
    auth_gc_interval_seconds: int = 60
    node_executable: str | None = None
    profile_store: str | None = None

    def __post_init__(self):
        try:
            if self.mode not in ('mock', 'real') or not isinstance(self.client_id, str) or not self.client_id:
                raise ValueError()
            if not isinstance(self.csrf_key, bytes) or len(self.csrf_key) < 32:
                raise ValueError()
            if type(self.auth_gc_interval_seconds) is not int or not 1 <= self.auth_gc_interval_seconds <= 60:
                raise ValueError()
            if (self.node_executable is None) != (self.profile_store is None):
                raise ValueError()
            for path in (self.node_executable, self.profile_store):
                if path is not None and (not isinstance(path, str) or not Path(path).is_absolute() or '\x00' in path):
                    raise ValueError()
            if (type(self.allowed_ui_origins) is not tuple or not self.allowed_ui_origins or
                    len(set(self.allowed_ui_origins)) != len(self.allowed_ui_origins)):
                raise ValueError()
            urls = [self.api_origin, self.issuer, self.authorization_endpoint, self.token_endpoint,
                    self.jwks_uri, self.redirect_uri, self.post_login_url, *self.allowed_ui_origins]
            for url in urls:
                url_origin(url)
                parts = urlsplit(url)
                if self.mode == 'real' and parts.scheme != 'https':
                    raise ValueError()
                if self.mode == 'mock' and parts.hostname not in ('127.0.0.1', '::1'):
                    raise ValueError()
            for origin in (self.api_origin, *self.allowed_ui_origins):
                if url_origin(origin) != origin:
                    raise ValueError()
            if self.redirect_uri != self.api_origin + '/auth/callback' or url_origin(self.post_login_url) not in self.allowed_ui_origins:
                raise ValueError()
            supported = {'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'}
            if (type(self.signing_algorithms) is not tuple or not self.signing_algorithms or
                    len(set(self.signing_algorithms)) != len(self.signing_algorithms) or not set(self.signing_algorithms) <= supported):
                raise ValueError()
            if self.client_auth_method not in ('client_secret_basic', 'none'):
                raise ValueError()
            if self.client_auth_method == 'client_secret_basic' and (not isinstance(self.client_secret, str) or not self.client_secret):
                raise ValueError()
        except Exception:
            raise SettingsError() from None


def load_settings(path):
    """Read only an explicitly selected private regular file, never AX settings."""
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError()
        with os.fdopen(descriptor, 'rb') as source:
            descriptor = None
            raw = source.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        data = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)
        encoded = data['csrf_key']
        key = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        if base64.urlsafe_b64encode(key).rstrip(b'=').decode() != encoded:
            raise ValueError()
        data['csrf_key'] = key
        for field in ('allowed_ui_origins', 'signing_algorithms'):
            if field in data:
                if not isinstance(data[field], list):
                    raise ValueError()
                data[field] = tuple(data[field])
        return Settings(**data)
    except Exception:
        raise SettingsError() from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
