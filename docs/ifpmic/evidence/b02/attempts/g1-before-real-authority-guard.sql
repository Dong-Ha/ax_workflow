-- B02 schema. Role placeholders are quoted identifiers supplied by the migrator.
CREATE TABLE ifpmic.users (
    user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_subject text NOT NULL UNIQUE CHECK (identity_subject <> ''),
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ifpmic.projects (
    project_id text PRIMARY KEY CHECK (project_id <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ifpmic.authorization_guards (
    project_id text PRIMARY KEY REFERENCES ifpmic.projects,
    lock_version bigint NOT NULL DEFAULT 0 CHECK (lock_version >= 0)
);
CREATE FUNCTION ifpmic.make_project_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO ifpmic.authorization_guards(project_id) VALUES (NEW.project_id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER project_guard AFTER INSERT ON ifpmic.projects
    FOR EACH ROW EXECUTE FUNCTION ifpmic.make_project_guard();
CREATE TABLE ifpmic.memberships (
    project_id text NOT NULL REFERENCES ifpmic.projects,
    user_id uuid NOT NULL REFERENCES ifpmic.users,
    active boolean NOT NULL DEFAULT true,
    capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
    lock_version bigint NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
    PRIMARY KEY (project_id, user_id),
    CHECK (capabilities <@ ARRAY['request.create']::text[])
);
-- Authority changes and acceptance serialize on a stable project guard.
-- Membership FOR UPDATE is possible with UPDATE(lock_version), without granting
-- UPDATE on any authority column. Snapshot/eligibility rows remain SELECT-only.
CREATE FUNCTION ifpmic.lock_project_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM ifpmic.authorization_guards
      WHERE project_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END
      FOR UPDATE;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER membership_guard BEFORE INSERT OR UPDATE OR DELETE ON ifpmic.memberships
    FOR EACH ROW EXECUTE FUNCTION ifpmic.lock_project_authority();
CREATE TABLE ifpmic.profile_catalog (
    project_id text NOT NULL REFERENCES ifpmic.projects,
    version_key text NOT NULL CHECK (length(version_key) = 64 AND version_key !~ '[^0-9a-f]'),
    snapshot_id text NOT NULL UNIQUE CHECK (length(snapshot_id) = 64 AND snapshot_id !~ '[^0-9a-f]'),
    record_bytes bytea NOT NULL CHECK (octet_length(record_bytes) BETWEEN 1 AND 2097152),
    record_bytes_sha256 text NOT NULL CHECK (length(record_bytes_sha256) = 64 AND record_bytes_sha256 !~ '[^0-9a-f]'),
    profile_version_json text NOT NULL CHECK (octet_length(profile_version_json) = length(profile_version_json)),
    mode text NOT NULL CHECK (mode IN ('mock', 'real')),
    enabled boolean NOT NULL,
    configuration_complete boolean NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, version_key),
    UNIQUE (project_id, snapshot_id),
    UNIQUE (project_id, snapshot_id, mode)
);
CREATE TABLE ifpmic.profile_eligibility (
    eligibility_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id text NOT NULL,
    snapshot_id text NOT NULL,
    mode text NOT NULL,
    authority_id text NOT NULL DEFAULT current_user CHECK (authority_id = current_user),
    evidence_ref text NOT NULL CHECK (evidence_ref <> ''),
    evidence_sha256 text NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 !~ '[^0-9a-f]'),
    granted_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > granted_at),
    FOREIGN KEY (project_id, snapshot_id, mode) REFERENCES ifpmic.profile_catalog(project_id, snapshot_id, mode),
    UNIQUE (project_id, eligibility_id)
);
CREATE TABLE ifpmic.profile_revocations (
    eligibility_id uuid PRIMARY KEY,
    project_id text NOT NULL,
    authority_id text NOT NULL DEFAULT current_user CHECK (authority_id = current_user),
    revoked_at timestamptz NOT NULL,
    FOREIGN KEY (project_id, eligibility_id) REFERENCES ifpmic.profile_eligibility(project_id, eligibility_id)
);
CREATE TRIGGER eligibility_guard BEFORE INSERT ON ifpmic.profile_eligibility
    FOR EACH ROW EXECUTE FUNCTION ifpmic.lock_project_authority();
CREATE TRIGGER revocation_guard BEFORE INSERT ON ifpmic.profile_revocations
    FOR EACH ROW EXECUTE FUNCTION ifpmic.lock_project_authority();
CREATE TABLE ifpmic.jobs (
    job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES ifpmic.users,
    project_id text NOT NULL REFERENCES ifpmic.projects,
    snapshot_id text NOT NULL,
    workflow_id text NOT NULL CHECK (workflow_id = 'ifpmic-sw-v1'),
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
      'DRAFT', 'QUEUED', 'RUNNING', 'WAITING_HUMAN', 'WAITING_DEVICE', 'PAUSED',
      'RECONCILING', 'FAILED', 'CANCELED', 'NO_CHANGE', 'RELEASED_PENDING_NOTES', 'COMPLETED')),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    cycle bigint NOT NULL DEFAULT 0 CHECK (cycle >= 0),
    current_step_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
    candidate_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, snapshot_id) REFERENCES ifpmic.profile_catalog(project_id, snapshot_id),
    UNIQUE (project_id, job_id)
);
CREATE INDEX jobs_owner_status_created ON ifpmic.jobs(owner_id, status, created_at, job_id);
CREATE TABLE ifpmic.job_delegations (
    delegation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id text NOT NULL,
    job_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES ifpmic.users,
    action text NOT NULL CHECK (action = 'job.read'),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (project_id, job_id) REFERENCES ifpmic.jobs(project_id, job_id)
);
CREATE TRIGGER delegation_guard BEFORE INSERT OR UPDATE OR DELETE ON ifpmic.job_delegations
    FOR EACH ROW EXECUTE FUNCTION ifpmic.lock_project_authority();
CREATE TABLE ifpmic.artifacts (
    artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id text NOT NULL REFERENCES ifpmic.projects,
    owner_id uuid NOT NULL REFERENCES ifpmic.users,
    job_id uuid,
    state text NOT NULL CHECK (state IN ('pending', 'available', 'rejected')),
    sha256 text NOT NULL CHECK (length(sha256) = 64 AND sha256 !~ '[^0-9a-f]'),
    size bigint NOT NULL CHECK (size >= 0),
    FOREIGN KEY (project_id, job_id) REFERENCES ifpmic.jobs(project_id, job_id)
);
CREATE TABLE ifpmic.commands (
    command_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid NOT NULL REFERENCES ifpmic.users,
    route text NOT NULL CHECK (route = 'POST /api/v1/jobs'),
    idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key !~ '[^ -~]'),
    project_id text NOT NULL,
    job_id uuid NOT NULL UNIQUE,
    command_payload_json text NOT NULL CHECK (octet_length(command_payload_json) = length(command_payload_json)),
    payload_sha256 text NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 !~ '[^0-9a-f]'),
    status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'applied', 'rejected')),
    applied_revision bigint CHECK (applied_revision >= 0),
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_id, route, idempotency_key),
    FOREIGN KEY (project_id, job_id) REFERENCES ifpmic.jobs(project_id, job_id),
    UNIQUE (command_id, job_id)
);
CREATE TABLE ifpmic.commands_outbox (
    command_id uuid PRIMARY KEY REFERENCES ifpmic.commands,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_outbox ON ifpmic.commands_outbox(state, created_at);
CREATE TABLE ifpmic.workspace_intents (
    job_id uuid PRIMARY KEY,
    command_id uuid NOT NULL UNIQUE,
    workspace_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'PROVISIONING', 'READY', 'ERROR')),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    claim_token uuid,
    claim_expires_at timestamptz,
    error_code text,
    FOREIGN KEY (command_id, job_id) REFERENCES ifpmic.commands(command_id, job_id)
);
CREATE TABLE ifpmic.oidc_login_transactions (
    state_hash text PRIMARY KEY CHECK (length(state_hash) = 64 AND state_hash !~ '[^0-9a-f]'),
    browser_hash text NOT NULL,
    nonce text NOT NULL,
    pkce_verifier text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE TABLE ifpmic.user_sessions (
    token_hash text PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash !~ '[^0-9a-f]'),
    user_id uuid NOT NULL REFERENCES ifpmic.users,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    last_seen_at timestamptz NOT NULL,
    revoked_at timestamptz
);

REVOKE ALL ON ALL TABLES IN SCHEMA ifpmic FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ifpmic FROM PUBLIC;
REVOKE ALL ON SCHEMA ifpmic FROM PUBLIC;
GRANT USAGE ON SCHEMA ifpmic TO {runtime_role}, {operator_role};
GRANT SELECT ON ALL TABLES IN SCHEMA ifpmic TO {runtime_role};
GRANT SELECT ON ifpmic.users, ifpmic.projects, ifpmic.authorization_guards,
    ifpmic.memberships, ifpmic.profile_catalog, ifpmic.profile_eligibility,
    ifpmic.profile_revocations, ifpmic.jobs, ifpmic.job_delegations,
    ifpmic.artifacts, ifpmic.workspace_intents TO {operator_role};
REVOKE ALL ON ifpmic.schema_migrations FROM {runtime_role}, {operator_role};
GRANT INSERT(user_id, identity_subject, display_name) ON ifpmic.users TO {runtime_role};
GRANT INSERT(job_id, owner_id, project_id, snapshot_id, workflow_id) ON ifpmic.jobs TO {runtime_role};
GRANT INSERT(command_id, actor_id, route, idempotency_key, project_id, job_id,
    command_payload_json, payload_sha256) ON ifpmic.commands TO {runtime_role};
GRANT INSERT(command_id) ON ifpmic.commands_outbox TO {runtime_role};
GRANT INSERT(job_id, command_id) ON ifpmic.workspace_intents TO {runtime_role};
GRANT INSERT(state_hash, browser_hash, nonce, pkce_verifier, expires_at)
    ON ifpmic.oidc_login_transactions TO {runtime_role};
GRANT INSERT(token_hash, user_id, created_at, expires_at, last_seen_at)
    ON ifpmic.user_sessions TO {runtime_role};
GRANT UPDATE(display_name) ON ifpmic.users TO {runtime_role};
GRANT UPDATE(last_seen_at, revoked_at) ON ifpmic.user_sessions TO {runtime_role};
GRANT UPDATE(consumed_at) ON ifpmic.oidc_login_transactions TO {runtime_role};
GRANT UPDATE(lock_version) ON ifpmic.memberships, ifpmic.authorization_guards TO {runtime_role};
GRANT UPDATE(state, generation, claim_token, claim_expires_at, error_code) ON ifpmic.workspace_intents TO {runtime_role};
GRANT INSERT ON ifpmic.projects, ifpmic.authorization_guards, ifpmic.memberships,
    ifpmic.profile_catalog, ifpmic.profile_eligibility, ifpmic.profile_revocations,
    ifpmic.job_delegations, ifpmic.artifacts TO {operator_role};
GRANT UPDATE(active, capabilities) ON ifpmic.memberships TO {operator_role};
GRANT UPDATE(revoked_at, expires_at) ON ifpmic.job_delegations TO {operator_role};
GRANT UPDATE(lock_version) ON ifpmic.authorization_guards TO {operator_role};
GRANT EXECUTE ON FUNCTION ifpmic.make_project_guard(), ifpmic.lock_project_authority() TO {operator_role};
-- Runtime cannot advance jobs, apply commands/outbox, change ownership,
-- mutate snapshots, or grant/revoke eligibility. B03 needs a separate migration.
