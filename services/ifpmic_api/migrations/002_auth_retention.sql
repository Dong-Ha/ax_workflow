-- Expiry-only application maintenance of ephemeral authentication data.
-- No owner/authority, immutable resource or user-history privileges change.
CREATE INDEX oidc_login_transactions_expiry ON ifpmic.oidc_login_transactions(expires_at, state_hash);
CREATE INDEX user_sessions_expiry ON ifpmic.user_sessions(expires_at, token_hash);
GRANT DELETE ON ifpmic.oidc_login_transactions, ifpmic.user_sessions TO {runtime_role};
