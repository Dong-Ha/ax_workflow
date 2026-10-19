-- H2: append-only execution protocol. Applied by a separate schema owner.
-- Role identifiers are supplied by the migrator; no credentials belong in SQL.
CREATE TABLE ifpmic.execution_role_config (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    migration_version text NOT NULL CHECK (migration_version='003_workflow_execution'),
    runtime_role_oid oid NOT NULL, runtime_role_name text NOT NULL,
    operator_role_oid oid NOT NULL, operator_role_name text NOT NULL,
    dispatcher_role_oid oid NOT NULL, dispatcher_role_name text NOT NULL,
    projector_role_oid oid NOT NULL, projector_role_name text NOT NULL
);

ALTER TABLE ifpmic.jobs ADD COLUMN create_command_id uuid;
ALTER TABLE ifpmic.jobs ADD COLUMN create_route text NOT NULL DEFAULT 'POST /api/v1/jobs'
    CHECK (create_route='POST /api/v1/jobs');
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM ifpmic.jobs j WHERE
        (SELECT count(*) FROM ifpmic.commands c WHERE c.job_id=j.job_id
         AND c.project_id=j.project_id AND c.route='POST /api/v1/jobs')<>1) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREATE_ORIGIN_INVALID';
    END IF;
END $$;
UPDATE ifpmic.jobs j SET create_command_id=c.command_id FROM ifpmic.commands c
 WHERE c.job_id=j.job_id AND c.project_id=j.project_id AND c.route='POST /api/v1/jobs';
ALTER TABLE ifpmic.jobs ALTER COLUMN create_command_id SET NOT NULL;
ALTER TABLE ifpmic.commands ADD CONSTRAINT command_job_route UNIQUE(command_id,job_id,route);
ALTER TABLE ifpmic.jobs ADD CONSTRAINT job_create_command FOREIGN KEY(create_command_id,job_id,create_route)
    REFERENCES ifpmic.commands(command_id,job_id,route) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ifpmic.jobs ADD CONSTRAINT job_create_pair UNIQUE(create_command_id,job_id);
ALTER TABLE ifpmic.workspace_intents ADD CONSTRAINT workspace_create_origin FOREIGN KEY(command_id,job_id)
    REFERENCES ifpmic.jobs(create_command_id,job_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ifpmic.commands DROP CONSTRAINT commands_job_id_key;
ALTER TABLE ifpmic.commands DROP CONSTRAINT commands_route_check;
ALTER TABLE ifpmic.commands ADD CONSTRAINT command_route_scope CHECK (
    route='POST /api/v1/jobs' OR
    route='POST /api/v1/jobs/'||job_id::text||'/human-submissions' OR
    route='POST /api/v1/jobs/'||job_id::text||'/plan-decision');
CREATE UNIQUE INDEX one_create_command ON ifpmic.commands(job_id) WHERE route='POST /api/v1/jobs';
ALTER TABLE ifpmic.commands ADD CONSTRAINT command_outcome_shape CHECK (
    (status='accepted' AND applied_revision IS NULL AND error_code IS NULL) OR
    (status='applied' AND applied_revision IS NOT NULL AND applied_revision>=1 AND error_code IS NULL) OR
    (status='rejected' AND applied_revision IS NULL AND error_code IS NOT NULL AND error_code IN ('FORBIDDEN','PROFILE_INELIGIBLE')));
GRANT INSERT(create_command_id) ON ifpmic.jobs TO {runtime_role};

CREATE TABLE ifpmic.execution_deployments (
    deployment_id text PRIMARY KEY CHECK (length(deployment_id) BETWEEN 1 AND 128),
    namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
    server_endpoint text NOT NULL CHECK (length(server_endpoint) BETWEEN 1 AND 256
        AND server_endpoint !~ '[@/?#[:space:]]'),
    server_config_sha256 text NOT NULL CHECK (server_config_sha256 ~ '^[0-9a-f]{{64}}$'),
    enabled boolean NOT NULL DEFAULT true,
    UNIQUE(deployment_id,namespace,server_config_sha256)
);
CREATE TABLE ifpmic.engine_builds (
    deployment_id text NOT NULL REFERENCES ifpmic.execution_deployments,
    build_id text NOT NULL CHECK (build_id ~ '^[0-9a-f]{{64}}$'),
    source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{{64}}$'),
    environment_manifest_sha256 text NOT NULL CHECK (environment_manifest_sha256 ~ '^[0-9a-f]{{64}}$'),
    workflow_type text NOT NULL CHECK (workflow_type='IFPMICJobWorkflow'),
    task_queue text NOT NULL CHECK (task_queue='ifpmic.build.'||build_id),
    protocol_version text NOT NULL CHECK (protocol_version='h2-v1'),
    enabled boolean NOT NULL DEFAULT true,
    PRIMARY KEY(deployment_id,build_id), UNIQUE(deployment_id,task_queue)
);
CREATE TABLE ifpmic.worker_principals (
    role_oid oid PRIMARY KEY, role_name text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('dispatcher','projector')),
    deployment_id text NOT NULL REFERENCES ifpmic.execution_deployments,
    build_id text,
    active boolean NOT NULL DEFAULT true,
    CHECK ((kind='dispatcher' AND build_id IS NULL) OR (kind='projector' AND build_id IS NOT NULL)),
    FOREIGN KEY(deployment_id,build_id) REFERENCES ifpmic.engine_builds,
    UNIQUE(role_oid,role_name,deployment_id,build_id)
);
CREATE UNIQUE INDEX one_deployment_dispatcher ON ifpmic.worker_principals(deployment_id) WHERE kind='dispatcher';
CREATE UNIQUE INDEX one_build_projector ON ifpmic.worker_principals(deployment_id,build_id) WHERE kind='projector';
CREATE TABLE ifpmic.execution_bindings (
    job_id uuid PRIMARY KEY REFERENCES ifpmic.jobs,
    project_id text NOT NULL,
    create_command_id uuid NOT NULL,
    deployment_id text NOT NULL,
    namespace text NOT NULL,
    server_config_sha256 text NOT NULL,
    temporal_workflow_id text NOT NULL CHECK (temporal_workflow_id='ifpmic.job.'||job_id::text),
    workflow_type text NOT NULL CHECK (workflow_type='IFPMICJobWorkflow'),
    build_id text NOT NULL,
    task_queue text NOT NULL CHECK (task_queue='ifpmic.build.'||build_id),
    snapshot_id text NOT NULL,
    catalog_record_sha256 text NOT NULL CHECK (catalog_record_sha256 ~ '^[0-9a-f]{{64}}$'),
    workflow_sha256 text NOT NULL CHECK (workflow_sha256 ~ '^[0-9a-f]{{64}}$'),
    state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{{64}}$'),
    agent_sha256 text NOT NULL CHECK (agent_sha256 ~ '^[0-9a-f]{{64}}$'),
    workspace_token uuid NOT NULL, workspace_generation bigint NOT NULL CHECK(workspace_generation>=0),
    command_payload_sha256 text NOT NULL CHECK (command_payload_sha256 ~ '^[0-9a-f]{{64}}$'),
    binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{{64}}$'),
    admitted_run_id uuid,
    state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','admitted','quarantined','closed')),
    first_start_attempt_at timestamptz,
    uncertain_until timestamptz,
    observed_retention_seconds bigint CHECK (observed_retention_seconds>3600),
    quarantine_code text,
    CONSTRAINT binding_start_window_shape CHECK ((first_start_attempt_at IS NULL AND uncertain_until IS NULL AND observed_retention_seconds IS NULL)
        OR (first_start_attempt_at IS NOT NULL AND uncertain_until IS NOT NULL AND observed_retention_seconds IS NOT NULL AND uncertain_until>first_start_attempt_at
            AND uncertain_until<=first_start_attempt_at+interval '1 hour' AND observed_retention_seconds>3600)),
    CONSTRAINT binding_run_shape CHECK ((state='reserved' AND admitted_run_id IS NULL) OR (state IN ('admitted','closed') AND admitted_run_id IS NOT NULL) OR state='quarantined'),
    FOREIGN KEY(project_id,job_id) REFERENCES ifpmic.jobs(project_id,job_id),
    FOREIGN KEY(create_command_id,job_id) REFERENCES ifpmic.jobs(create_command_id,job_id),
    FOREIGN KEY(project_id,snapshot_id) REFERENCES ifpmic.profile_catalog(project_id,snapshot_id),
    FOREIGN KEY(deployment_id,namespace,server_config_sha256) REFERENCES ifpmic.execution_deployments(deployment_id,namespace,server_config_sha256),
    FOREIGN KEY(deployment_id,build_id) REFERENCES ifpmic.engine_builds,
    UNIQUE(deployment_id,namespace,temporal_workflow_id), UNIQUE(job_id,admitted_run_id),
    UNIQUE(job_id,admitted_run_id,deployment_id,build_id)
);
CREATE TABLE ifpmic.worker_run_scopes (
    job_id uuid NOT NULL, admitted_run_id uuid NOT NULL,
    projector_role_oid oid NOT NULL, projector_role_name text NOT NULL,
    deployment_id text NOT NULL, build_id text NOT NULL,
    PRIMARY KEY(job_id,admitted_run_id),
    FOREIGN KEY(projector_role_oid,projector_role_name,deployment_id,build_id)
      REFERENCES ifpmic.worker_principals(role_oid,role_name,deployment_id,build_id),
    FOREIGN KEY(job_id,admitted_run_id,deployment_id,build_id)
      REFERENCES ifpmic.execution_bindings(job_id,admitted_run_id,deployment_id,build_id)
);
ALTER TABLE ifpmic.commands_outbox DROP CONSTRAINT commands_outbox_state_check;
ALTER TABLE ifpmic.commands_outbox ADD CONSTRAINT outbox_states CHECK (state IN ('pending','leased','uncertain','dispatched','quarantined'));
ALTER TABLE ifpmic.commands_outbox ADD COLUMN generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0);
ALTER TABLE ifpmic.commands_outbox ADD COLUMN claim_token uuid;
ALTER TABLE ifpmic.commands_outbox ADD COLUMN claim_expires_at timestamptz;
ALTER TABLE ifpmic.commands_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ifpmic.commands_outbox ADD COLUMN last_error text;
ALTER TABLE ifpmic.commands_outbox ADD COLUMN observed_run_id uuid;
ALTER TABLE ifpmic.commands_outbox ADD COLUMN dispatched_at timestamptz;
ALTER TABLE ifpmic.commands_outbox ADD CONSTRAINT outbox_claim_shape CHECK (
    (state='leased' AND generation>0 AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL) OR
    (state<>'leased' AND claim_token IS NULL AND claim_expires_at IS NULL));
CREATE TABLE ifpmic.delivery_attempts (
    command_id uuid NOT NULL REFERENCES ifpmic.commands_outbox,
    generation bigint NOT NULL CHECK(generation>0),
    attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
    result text CHECK(result IN ('started','signaled','uncertain','retry','receipt_reconciled','quarantined','expired')),
    observed_run_id uuid, error_code text,
    PRIMARY KEY(command_id,generation),
    CHECK ((completed_at IS NULL AND result IS NULL) OR (completed_at IS NOT NULL AND result IS NOT NULL))
);
CREATE TABLE ifpmic.projection_receipts (
    job_id uuid NOT NULL REFERENCES ifpmic.jobs,
    transition_sequence bigint NOT NULL CHECK(transition_sequence>=1),
    command_id uuid NOT NULL UNIQUE REFERENCES ifpmic.commands,
    admitted_run_id uuid NOT NULL, build_id text NOT NULL,
    proposal_sha256 text NOT NULL CHECK(proposal_sha256 ~ '^[0-9a-f]{{64}}$'),
    expected_revision bigint NOT NULL CHECK(expected_revision>=0),
    outcome text NOT NULL CHECK(outcome IN ('applied','rejected')),
    result_json jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(job_id,transition_sequence),
    FOREIGN KEY(job_id,admitted_run_id) REFERENCES ifpmic.execution_bindings(job_id,admitted_run_id)
);

-- Identity columns never become writable through a worker function.
CREATE FUNCTION ifpmic.h2_immutable_except() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,ifpmic,pg_temp AS $$
BEGIN
    IF TG_OP='DELETE' OR (to_jsonb(NEW)-coalesce(TG_ARGV,ARRAY[]::text[])) IS DISTINCT FROM (to_jsonb(OLD)-coalesce(TG_ARGV,ARRAY[]::text[])) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='IMMUTABLE_EXECUTION_IDENTITY';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER immutable_deployment BEFORE UPDATE OR DELETE ON ifpmic.execution_deployments
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except('enabled');
CREATE TRIGGER immutable_build BEFORE UPDATE OR DELETE ON ifpmic.engine_builds
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except('enabled');
CREATE TRIGGER immutable_principal BEFORE UPDATE OR DELETE ON ifpmic.worker_principals
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except('active');
CREATE TRIGGER immutable_scope BEFORE UPDATE OR DELETE ON ifpmic.worker_run_scopes
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON ifpmic.projection_receipts
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except();
CREATE TRIGGER immutable_role_config BEFORE UPDATE OR DELETE ON ifpmic.execution_role_config
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except();
CREATE TRIGGER immutable_command BEFORE UPDATE OR DELETE ON ifpmic.commands
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except('status','applied_revision','error_code');
CREATE TRIGGER immutable_job_origin BEFORE UPDATE OR DELETE ON ifpmic.jobs
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except('status','revision','cycle','current_step_ids','candidate_fingerprint');
CREATE TRIGGER immutable_workspace_origin BEFORE UPDATE OR DELETE ON ifpmic.workspace_intents
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except('state','generation','claim_token','claim_expires_at','error_code');
CREATE FUNCTION ifpmic.h2_binding_write_once() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,ifpmic,pg_temp AS $$
BEGIN
    IF (OLD.admitted_run_id IS NOT NULL AND NEW.admitted_run_id IS DISTINCT FROM OLD.admitted_run_id)
       OR (OLD.first_start_attempt_at IS NOT NULL AND
           ROW(NEW.first_start_attempt_at,NEW.uncertain_until,NEW.observed_retention_seconds)
             IS DISTINCT FROM ROW(OLD.first_start_attempt_at,OLD.uncertain_until,OLD.observed_retention_seconds))
       OR (OLD.state='quarantined' AND NEW.state<>'quarantined') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='IMMUTABLE_EXECUTION_BINDING';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON ifpmic.execution_bindings
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_immutable_except('admitted_run_id','state','first_start_attempt_at','uncertain_until','observed_retention_seconds','quarantine_code');
CREATE TRIGGER binding_write_once BEFORE UPDATE ON ifpmic.execution_bindings
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_binding_write_once();
CREATE FUNCTION ifpmic.h2_terminal_command() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,ifpmic,pg_temp AS $$
BEGIN
    IF OLD.status<>'accepted' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='IMMUTABLE_COMMAND_OUTCOME';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER terminal_command BEFORE UPDATE ON ifpmic.commands
 FOR EACH ROW EXECUTE FUNCTION ifpmic.h2_terminal_command();

-- Same ASCII canonical JSON as request_contract.ascii_json; integer-only domain.
CREATE FUNCTION ifpmic.h2_json_string(p_text text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE answer text := chr(34); ch text; cp integer; i integer;
BEGIN
    FOR i IN 1..length(p_text) LOOP
        ch:=substr(p_text,i,1); cp:=ascii(ch);
        IF cp IN (34,92) THEN answer:=answer||chr(92)||ch;
        ELSIF cp=8 THEN answer:=answer||chr(92)||'b';
        ELSIF cp=9 THEN answer:=answer||chr(92)||'t';
        ELSIF cp=10 THEN answer:=answer||chr(92)||'n';
        ELSIF cp=12 THEN answer:=answer||chr(92)||'f';
        ELSIF cp=13 THEN answer:=answer||chr(92)||'r';
        ELSIF cp<32 OR cp>126 THEN
            IF cp<=65535 THEN answer:=answer||chr(92)||'u'||lpad(to_hex(cp),4,'0');
            ELSE cp:=cp-65536; answer:=answer||chr(92)||'u'||to_hex(55296+(cp/1024))||chr(92)||'u'||to_hex(56320+(cp%1024)); END IF;
        ELSE answer:=answer||ch;
        END IF;
    END LOOP;
    RETURN answer||chr(34);
END $$;
CREATE FUNCTION ifpmic.h2_canonical(p_value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE answer text; pair record; delimiter text := ''; kind text := jsonb_typeof(p_value);
BEGIN
    IF kind='object' THEN
        answer:=chr(123);
        FOR pair IN SELECT key,value FROM jsonb_each(p_value) ORDER BY key COLLATE "C" LOOP
            answer:=answer||delimiter||ifpmic.h2_json_string(pair.key)||':'||ifpmic.h2_canonical(pair.value); delimiter:=',';
        END LOOP;
        RETURN answer||chr(125);
    ELSIF kind='array' THEN
        answer:='[';
        FOR pair IN SELECT value FROM jsonb_array_elements(p_value) WITH ORDINALITY ORDER BY ordinality LOOP
            answer:=answer||delimiter||ifpmic.h2_canonical(pair.value); delimiter:=',';
        END LOOP;
        RETURN answer||']';
    ELSIF kind='string' THEN RETURN ifpmic.h2_json_string(p_value #>> ARRAY[]::text[]);
    ELSIF kind IN ('boolean','null') THEN RETURN p_value::text;
    ELSIF kind='number' AND p_value::text ~ '^-?[0-9]+$' THEN RETURN p_value::text;
    END IF;
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='INVALID_CANONICAL_VALUE';
END $$;
CREATE FUNCTION ifpmic.h2_digest(p_domain text,p_value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,ifpmic,pg_temp AS $$
    SELECT encode(sha256(convert_to(p_domain,'UTF8')||decode('00','hex')||convert_to(ifpmic.h2_canonical(p_value),'UTF8')),'hex')
$$;

-- Every entry point resolves the authenticated login, never current_user/GUCs.
CREATE FUNCTION ifpmic.h2_identity(p_kind text,p_peer_oid oid DEFAULT NULL)
RETURNS ifpmic.worker_principals LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; entry record; oid_value oid;
BEGIN
    SELECT oid INTO oid_value FROM pg_roles WHERE rolname=session_user
       AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
    IF oid_value IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=oid_value OR roleid=oid_value) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;
    FOR entry IN SELECT role_oid FROM ifpmic.worker_principals
       WHERE role_oid=oid_value OR role_oid=p_peer_oid ORDER BY role_oid FOR SHARE LOOP NULL; END LOOP;
    SELECT * INTO me FROM ifpmic.worker_principals
       WHERE role_oid=oid_value AND role_name=session_user AND kind=p_kind AND active;
    IF NOT FOUND OR (p_peer_oid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ifpmic.worker_principals
       WHERE role_oid=p_peer_oid AND kind='projector' AND active AND deployment_id=me.deployment_id)) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;
    RETURN me;
END $$;
CREATE FUNCTION ifpmic.h2_lock_job(p_job_id uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE project_value text; actor_value uuid;
BEGIN
    SELECT project_id,owner_id INTO project_value,actor_value FROM ifpmic.jobs WHERE job_id=p_job_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    PERFORM 1 FROM ifpmic.authorization_guards WHERE project_id=project_value FOR UPDATE;
    PERFORM 1 FROM ifpmic.memberships WHERE project_id=project_value AND user_id=actor_value FOR UPDATE NOWAIT;
    PERFORM 1 FROM ifpmic.jobs WHERE job_id=p_job_id FOR UPDATE;
    PERFORM 1 FROM ifpmic.execution_bindings WHERE job_id=p_job_id FOR UPDATE;
    PERFORM 1 FROM ifpmic.workspace_intents WHERE job_id=p_job_id FOR SHARE;
END $$;
CREATE FUNCTION ifpmic.h2_scope(p_job_id uuid,p_run_id text,p_build_id text,p_allow_pending boolean DEFAULT false)
RETURNS ifpmic.execution_bindings LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; binding ifpmic.execution_bindings;
BEGIN
    me:=ifpmic.h2_identity('projector');
    SELECT * INTO binding FROM ifpmic.execution_bindings WHERE job_id=p_job_id
       AND deployment_id=me.deployment_id AND build_id=me.build_id AND build_id=p_build_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    IF p_allow_pending AND binding.admitted_run_id IS NULL THEN RETURN binding; END IF;
    IF binding.admitted_run_id::text IS DISTINCT FROM p_run_id OR NOT EXISTS (
        SELECT 1 FROM ifpmic.worker_run_scopes WHERE job_id=p_job_id AND admitted_run_id=binding.admitted_run_id
        AND projector_role_oid=me.role_oid AND projector_role_name=me.role_name
        AND deployment_id=me.deployment_id AND build_id=me.build_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;
    RETURN binding;
END $$;
CREATE FUNCTION ifpmic.read_dispatch_config() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; answer jsonb;
BEGIN
    me:=ifpmic.h2_identity('dispatcher');
    SELECT jsonb_build_object('deployment_id',d.deployment_id,'namespace',d.namespace,
        'server_endpoint',d.server_endpoint,'server_config_sha256',d.server_config_sha256,
        'builds',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY build_id),'[]'::jsonb)
          FROM ifpmic.engine_builds b WHERE b.deployment_id=d.deployment_id AND b.enabled))
      INTO answer FROM ifpmic.execution_deployments d WHERE d.deployment_id=me.deployment_id AND d.enabled;
    IF answer IS NULL OR jsonb_array_length(answer->'builds')=0 THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='BUILD_UNAVAILABLE';
    END IF;
    RETURN answer;
END $$;
CREATE FUNCTION ifpmic.read_registered_build(p_build_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; answer jsonb;
BEGIN
    me:=ifpmic.h2_identity('projector');
    SELECT to_jsonb(b)||jsonb_build_object('namespace',d.namespace,'server_endpoint',d.server_endpoint,
       'server_config_sha256',d.server_config_sha256) INTO answer
      FROM ifpmic.engine_builds b JOIN ifpmic.execution_deployments d USING(deployment_id)
      WHERE b.deployment_id=me.deployment_id AND b.build_id=me.build_id AND b.build_id=p_build_id AND b.enabled AND d.enabled;
    IF answer IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='BUILD_UNAVAILABLE'; END IF;
    RETURN answer;
END $$;

CREATE FUNCTION ifpmic.h2_catalog(p_job_id uuid) RETURNS ifpmic.profile_catalog LANGUAGE plpgsql SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE catalog ifpmic.profile_catalog;
BEGIN
    -- G4's trusted Node bridge validates the record and binds all nine catalog
    -- fields before accepting a job. Service roles cannot UPDATE/DELETE catalog.
    -- Keep that producer boundary: JSONB decoding here would reject supported
    -- escaped lone-surrogate profile versions. A digest is not an attestation
    -- for arbitrary SQL-created jobs; new producers require a reviewed boundary.
    SELECT c.* INTO catalog FROM ifpmic.jobs j JOIN ifpmic.profile_catalog c
      ON c.project_id=j.project_id AND c.snapshot_id=j.snapshot_id WHERE j.job_id=p_job_id;
    IF NOT FOUND OR encode(sha256(catalog.record_bytes),'hex') IS DISTINCT FROM catalog.record_bytes_sha256 THEN RETURN NULL; END IF;
    RETURN catalog;
END $$;
CREATE FUNCTION ifpmic.h2_binding_document(p_binding ifpmic.execution_bindings) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,ifpmic,pg_temp AS $$
    SELECT to_jsonb(p_binding)-ARRAY['binding_sha256','admitted_run_id','state','first_start_attempt_at',
        'uncertain_until','observed_retention_seconds','quarantine_code']::text[]
$$;
CREATE FUNCTION ifpmic.h2_quarantine(p_job_id uuid,p_code text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,ifpmic,pg_temp AS $$
BEGIN
    IF p_code IS NULL OR p_code NOT IN ('BINDING_CONFLICT','BUILD_UNAVAILABLE','RUN_CONFLICT','HISTORY_MISSING',
       'START_WINDOW_EXPIRED','RETENTION_UNVERIFIED','WORKSPACE_IDENTITY_CONFLICT','CATALOG_IDENTITY_CONFLICT',
       'PROPOSAL_COLLISION','PREDECESSOR_CONFLICT','COMMAND_IDENTITY_CONFLICT') THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='INVALID_INCIDENT_CODE';
    END IF;
    PERFORM 1 FROM ifpmic.commands_outbox o JOIN ifpmic.commands c USING(command_id)
      WHERE c.job_id=p_job_id ORDER BY o.command_id FOR UPDATE OF o;
    UPDATE ifpmic.execution_bindings SET state='quarantined',quarantine_code=coalesce(quarantine_code,p_code) WHERE job_id=p_job_id;
    UPDATE ifpmic.delivery_attempts a SET completed_at=clock_timestamp(),result='quarantined',error_code=p_code
      FROM ifpmic.commands_outbox o JOIN ifpmic.commands c USING(command_id)
      WHERE c.job_id=p_job_id AND a.command_id=o.command_id AND a.generation=o.generation AND a.completed_at IS NULL;
    UPDATE ifpmic.commands_outbox o SET state='quarantined',claim_token=NULL,claim_expires_at=NULL,last_error=p_code
      FROM ifpmic.commands c WHERE c.command_id=o.command_id AND c.job_id=p_job_id AND o.state<>'dispatched';
END $$;
CREATE FUNCTION ifpmic.claim_delivery(p_command_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; item ifpmic.commands_outbox; command_value ifpmic.commands; job_value ifpmic.jobs;
BEGIN
    me:=ifpmic.h2_identity('dispatcher');
    IF NOT EXISTS(SELECT 1 FROM ifpmic.execution_deployments WHERE deployment_id=me.deployment_id AND enabled) THEN
        RETURN jsonb_build_object('status','idle');
    END IF;
    SELECT o.* INTO item FROM ifpmic.commands_outbox o JOIN ifpmic.commands c USING(command_id)
       LEFT JOIN ifpmic.execution_bindings b ON b.job_id=c.job_id
       WHERE (p_command_id IS NULL OR o.command_id=p_command_id)
       AND ((o.state IN ('pending','uncertain') AND o.next_attempt_at<=clock_timestamp())
          OR (o.state='leased' AND o.claim_expires_at<=clock_timestamp()))
       AND (b.job_id IS NULL OR (b.deployment_id=me.deployment_id AND b.state<>'quarantined'))
       AND (c.route='POST /api/v1/jobs' OR b.admitted_run_id IS NOT NULL)
       ORDER BY o.next_attempt_at,o.created_at,o.command_id FOR UPDATE OF o SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
    UPDATE ifpmic.delivery_attempts SET completed_at=clock_timestamp(),result='expired'
       WHERE command_id=item.command_id AND generation=item.generation AND completed_at IS NULL;
    UPDATE ifpmic.commands_outbox SET state='leased',generation=generation+1,claim_token=gen_random_uuid(),
       claim_expires_at=clock_timestamp()+interval '30 seconds' WHERE command_id=item.command_id RETURNING * INTO item;
    INSERT INTO ifpmic.delivery_attempts(command_id,generation) VALUES(item.command_id,item.generation);
    SELECT * INTO command_value FROM ifpmic.commands WHERE command_id=item.command_id;
    SELECT * INTO job_value FROM ifpmic.jobs WHERE job_id=command_value.job_id;
    RETURN jsonb_build_object('status','claimed','command_id',item.command_id,'generation',item.generation,
       'claim_token',item.claim_token,'claim_expires_at',item.claim_expires_at,'job_id',job_value.job_id,
       'project_id',job_value.project_id,'route',command_value.route,'payload_sha256',command_value.payload_sha256,
       'command_status',command_value.status,'create_command_id',job_value.create_command_id,
       'binding',(SELECT to_jsonb(b) FROM ifpmic.execution_bindings b WHERE b.job_id=job_value.job_id),
       'workspace',(SELECT jsonb_build_object('state',w.state,'workspace_token',w.workspace_token,'generation',w.generation)
          FROM ifpmic.workspace_intents w WHERE w.job_id=job_value.job_id));
END $$;
CREATE FUNCTION ifpmic.reserve_execution(p_command_id uuid,p_generation bigint,p_claim_token uuid,p_build_id text,
    p_workspace_token uuid,p_workspace_generation bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; cmd ifpmic.commands; job_value ifpmic.jobs; item ifpmic.commands_outbox;
    build_value ifpmic.engine_builds; deployment ifpmic.execution_deployments; workspace ifpmic.workspace_intents;
    catalog ifpmic.profile_catalog; binding ifpmic.execution_bindings; previous ifpmic.execution_bindings; expected_hash text; identity_bytes text;
BEGIN
    me:=ifpmic.h2_identity('dispatcher');
    SELECT * INTO cmd FROM ifpmic.commands WHERE command_id=p_command_id;
    IF NOT FOUND OR cmd.route<>'POST /api/v1/jobs' THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    PERFORM ifpmic.h2_lock_job(cmd.job_id);
    SELECT * INTO item FROM ifpmic.commands_outbox WHERE command_id=p_command_id FOR UPDATE;
    IF item.state IS DISTINCT FROM 'leased' OR item.generation IS DISTINCT FROM p_generation
       OR item.claim_token IS DISTINCT FROM p_claim_token OR item.claim_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('status','stale','code','CLAIM_STALE');
    END IF;
    SELECT * INTO job_value FROM ifpmic.jobs WHERE job_id=cmd.job_id;
    IF job_value.create_command_id IS DISTINCT FROM cmd.command_id OR job_value.owner_id IS DISTINCT FROM cmd.actor_id THEN
        PERFORM ifpmic.h2_quarantine(cmd.job_id,'COMMAND_IDENTITY_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','COMMAND_IDENTITY_CONFLICT');
    END IF;
    SELECT * INTO previous FROM ifpmic.execution_bindings WHERE job_id=cmd.job_id;
    IF FOUND AND (previous.deployment_id<>me.deployment_id OR previous.build_id IS DISTINCT FROM p_build_id) THEN
        -- A different deployment is not this principal's incident to mutate.
        IF previous.deployment_id<>me.deployment_id THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
        PERFORM ifpmic.h2_quarantine(cmd.job_id,'BINDING_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','BINDING_CONFLICT');
    END IF;
    IF previous.state='quarantined' THEN RETURN jsonb_build_object('status','quarantined','code',previous.quarantine_code); END IF;
    SELECT * INTO deployment FROM ifpmic.execution_deployments WHERE deployment_id=me.deployment_id AND enabled;
    SELECT * INTO build_value FROM ifpmic.engine_builds WHERE deployment_id=me.deployment_id AND build_id=p_build_id AND enabled;
    IF deployment.deployment_id IS NULL OR build_value.build_id IS NULL OR NOT EXISTS(
       SELECT 1 FROM ifpmic.worker_principals WHERE deployment_id=me.deployment_id AND build_id=p_build_id AND kind='projector' AND active) THEN
        RETURN jsonb_build_object('status','wait','code','BUILD_UNAVAILABLE');
    END IF;
    SELECT * INTO workspace FROM ifpmic.workspace_intents WHERE job_id=cmd.job_id;
    IF workspace.state IS DISTINCT FROM 'READY' THEN RETURN jsonb_build_object('status','wait','code','WORKSPACE_NOT_READY'); END IF;
    IF workspace.command_id IS DISTINCT FROM cmd.command_id OR workspace.workspace_token IS DISTINCT FROM p_workspace_token
       OR workspace.generation IS DISTINCT FROM p_workspace_generation THEN
        PERFORM ifpmic.h2_quarantine(cmd.job_id,'WORKSPACE_IDENTITY_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','WORKSPACE_IDENTITY_CONFLICT');
    END IF;
    catalog:=ifpmic.h2_catalog(cmd.job_id);
    IF catalog.snapshot_id IS NULL THEN
        PERFORM ifpmic.h2_quarantine(cmd.job_id,'CATALOG_IDENTITY_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','CATALOG_IDENTITY_CONFLICT');
    END IF;
    BEGIN
        -- G4 persists strict, fixed-key canonical ASCII JSON. Hash original bytes,
        -- preserving supported lone surrogate escapes in title/request_text.
        -- PostgreSQL JSON processing can reject those otherwise accepted bytes.
        expected_hash:=encode(sha256(convert_to('{{"format":"ifpmic.create-job.v1","payload":'||cmd.command_payload_json||'}}','UTF8')),'hex');
        -- These three keys are adjacent in the fixed sorted CreateJob object.
        -- Embedded user quotes are escaped and cannot forge this field boundary.
        identity_bytes:=',"profile_version":'||catalog.profile_version_json||',"project_id":'||
            ifpmic.h2_json_string(job_value.project_id)||',"release_mode":';
    EXCEPTION WHEN OTHERS THEN expected_hash:=NULL; END;
    IF expected_hash IS DISTINCT FROM cmd.payload_sha256 OR position(identity_bytes IN cmd.command_payload_json)=0 THEN
        PERFORM ifpmic.h2_quarantine(cmd.job_id,'COMMAND_IDENTITY_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','COMMAND_IDENTITY_CONFLICT');
    END IF;
    binding.job_id:=job_value.job_id; binding.project_id:=job_value.project_id; binding.create_command_id:=cmd.command_id;
    binding.deployment_id:=deployment.deployment_id; binding.namespace:=deployment.namespace;
    binding.server_config_sha256:=deployment.server_config_sha256; binding.temporal_workflow_id:='ifpmic.job.'||cmd.job_id::text;
    binding.workflow_type:=build_value.workflow_type; binding.build_id:=build_value.build_id; binding.task_queue:=build_value.task_queue;
    binding.snapshot_id:=job_value.snapshot_id; binding.catalog_record_sha256:=catalog.record_bytes_sha256;
    binding.workflow_sha256:='bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89';
    binding.state_sha256:='0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a';
    binding.agent_sha256:='ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64';
    binding.command_payload_sha256:=cmd.payload_sha256; binding.state:='reserved';
    binding.workspace_token:=workspace.workspace_token; binding.workspace_generation:=workspace.generation;
    binding.binding_sha256:=ifpmic.h2_digest('ifpmic.b03.execution-binding.v1',ifpmic.h2_binding_document(binding));
    IF previous.job_id IS NOT NULL THEN
        IF previous.binding_sha256 IS DISTINCT FROM binding.binding_sha256 THEN
            PERFORM ifpmic.h2_quarantine(cmd.job_id,'BINDING_CONFLICT');
            RETURN jsonb_build_object('status','quarantined','code','BINDING_CONFLICT');
        END IF;
        RETURN jsonb_build_object('status','reserved','binding',to_jsonb(previous));
    END IF;
    INSERT INTO ifpmic.execution_bindings SELECT (binding).*;
    RETURN jsonb_build_object('status','reserved','binding',to_jsonb(binding));
END $$;
CREATE FUNCTION ifpmic.record_start_attempt(p_command_id uuid,p_generation bigint,p_claim_token uuid,p_retention_seconds bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; item ifpmic.commands_outbox; binding ifpmic.execution_bindings; instant timestamptz;
BEGIN
    me:=ifpmic.h2_identity('dispatcher');
    SELECT b.* INTO binding FROM ifpmic.execution_bindings b WHERE b.create_command_id=p_command_id AND b.deployment_id=me.deployment_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    PERFORM ifpmic.h2_lock_job(binding.job_id);
    SELECT * INTO binding FROM ifpmic.execution_bindings WHERE job_id=binding.job_id;
    SELECT * INTO item FROM ifpmic.commands_outbox WHERE command_id=p_command_id FOR UPDATE;
    instant:=clock_timestamp();
    IF item.state IS DISTINCT FROM 'leased' OR item.generation IS DISTINCT FROM p_generation
       OR item.claim_token IS DISTINCT FROM p_claim_token OR item.claim_expires_at<=instant THEN
        RETURN jsonb_build_object('status','stale','code','CLAIM_STALE');
    END IF;
    IF binding.state='quarantined' THEN RETURN jsonb_build_object('status','quarantined','code',binding.quarantine_code); END IF;
    IF binding.admitted_run_id IS NOT NULL THEN RETURN jsonb_build_object('status','admitted','binding',to_jsonb(binding)); END IF;
    IF p_retention_seconds IS NULL OR p_retention_seconds<=3600 THEN
        PERFORM ifpmic.h2_quarantine(binding.job_id,'RETENTION_UNVERIFIED');
        RETURN jsonb_build_object('status','quarantined','code','RETENTION_UNVERIFIED');
    END IF;
    IF binding.first_start_attempt_at IS NULL THEN
        UPDATE ifpmic.execution_bindings SET first_start_attempt_at=instant,uncertain_until=instant+interval '1 hour',
            observed_retention_seconds=p_retention_seconds WHERE job_id=binding.job_id RETURNING * INTO binding;
    ELSIF binding.uncertain_until<=instant THEN
        PERFORM ifpmic.h2_quarantine(binding.job_id,'START_WINDOW_EXPIRED');
        RETURN jsonb_build_object('status','quarantined','code','START_WINDOW_EXPIRED');
    END IF;
    RETURN jsonb_build_object('status','permitted','binding',to_jsonb(binding));
END $$;
CREATE FUNCTION ifpmic.admit_run(p_command_id uuid,p_generation bigint,p_claim_token uuid,p_run_id text,p_observed_binding_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; peer ifpmic.worker_principals; binding ifpmic.execution_bindings;
    item ifpmic.commands_outbox; run_value uuid;
BEGIN
    SELECT b.* INTO binding FROM ifpmic.execution_bindings b WHERE b.create_command_id=p_command_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    SELECT * INTO peer FROM ifpmic.worker_principals WHERE deployment_id=binding.deployment_id AND build_id=binding.build_id AND kind='projector';
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    me:=ifpmic.h2_identity('dispatcher',peer.role_oid);
    IF binding.deployment_id<>me.deployment_id THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    BEGIN run_value:=p_run_id::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='RUN_CONFLICT'; END;
    IF run_value IS NULL OR run_value::text IS DISTINCT FROM p_run_id THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='RUN_CONFLICT'; END IF;
    PERFORM ifpmic.h2_lock_job(binding.job_id);
    SELECT * INTO binding FROM ifpmic.execution_bindings WHERE job_id=binding.job_id;
    SELECT * INTO item FROM ifpmic.commands_outbox WHERE command_id=p_command_id FOR UPDATE;
    IF item.state IS DISTINCT FROM 'leased' OR item.generation IS DISTINCT FROM p_generation
       OR item.claim_token IS DISTINCT FROM p_claim_token OR item.claim_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('status','stale','code','CLAIM_STALE');
    END IF;
    IF binding.state='quarantined' THEN RETURN jsonb_build_object('status','quarantined','code',binding.quarantine_code); END IF;
    IF binding.binding_sha256 IS DISTINCT FROM p_observed_binding_sha256 THEN
        PERFORM ifpmic.h2_quarantine(binding.job_id,'BINDING_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','BINDING_CONFLICT');
    END IF;
    IF binding.admitted_run_id IS NOT NULL AND binding.admitted_run_id<>run_value THEN
        PERFORM ifpmic.h2_quarantine(binding.job_id,'RUN_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','RUN_CONFLICT');
    END IF;
    IF binding.admitted_run_id IS NULL THEN
        IF binding.uncertain_until IS NULL OR binding.uncertain_until<=clock_timestamp() THEN
            PERFORM ifpmic.h2_quarantine(binding.job_id,'START_WINDOW_EXPIRED');
            RETURN jsonb_build_object('status','quarantined','code','START_WINDOW_EXPIRED');
        END IF;
        UPDATE ifpmic.execution_bindings SET admitted_run_id=run_value,state='admitted' WHERE job_id=binding.job_id RETURNING * INTO binding;
        INSERT INTO ifpmic.worker_run_scopes(job_id,admitted_run_id,projector_role_oid,projector_role_name,deployment_id,build_id)
          VALUES(binding.job_id,run_value,peer.role_oid,peer.role_name,binding.deployment_id,binding.build_id);
    END IF;
    RETURN jsonb_build_object('status','admitted','binding',to_jsonb(binding));
END $$;
CREATE FUNCTION ifpmic.record_delivery(p_command_id uuid,p_generation bigint,p_claim_token uuid,p_result text,
    p_run_id text DEFAULT NULL,p_error_code text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; item ifpmic.commands_outbox; binding ifpmic.execution_bindings;
    cmd ifpmic.commands; target_state text; delay_seconds integer;
BEGIN
    me:=ifpmic.h2_identity('dispatcher');
    SELECT * INTO cmd FROM ifpmic.commands WHERE command_id=p_command_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    SELECT * INTO binding FROM ifpmic.execution_bindings WHERE job_id=cmd.job_id;
    IF binding.job_id IS NOT NULL AND binding.deployment_id<>me.deployment_id THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;
    SELECT * INTO item FROM ifpmic.commands_outbox WHERE command_id=p_command_id FOR UPDATE;
    IF item.state IS DISTINCT FROM 'leased' OR item.generation IS DISTINCT FROM p_generation
       OR item.claim_token IS DISTINCT FROM p_claim_token OR item.claim_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('status','stale','affected',0,'code','CLAIM_STALE');
    END IF;
    IF p_result IS NULL OR p_result NOT IN ('started','signaled','uncertain','retry','receipt_reconciled')
       OR (p_error_code IS NOT NULL AND p_error_code NOT IN ('WORKSPACE_NOT_READY','DEPENDENCY_UNAVAILABLE',
           'CLAIM_STALE','COMMIT_UNCERTAIN','BINDING_NOT_ADMITTED','BUILD_UNAVAILABLE')) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='INVALID_DELIVERY_RESULT';
    END IF;
    IF p_result IN ('started','signaled','receipt_reconciled') THEN
        IF binding.admitted_run_id IS NULL OR binding.admitted_run_id::text IS DISTINCT FROM p_run_id
           OR binding.state='quarantined' OR p_error_code IS NOT NULL
           OR (p_result='started' AND cmd.route<>'POST /api/v1/jobs')
           OR (p_result='signaled' AND cmd.route='POST /api/v1/jobs') THEN
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='RUN_CONFLICT';
        END IF;
        IF p_result='receipt_reconciled' AND NOT EXISTS(SELECT 1 FROM ifpmic.projection_receipts
            WHERE command_id=p_command_id AND job_id=cmd.job_id AND admitted_run_id=binding.admitted_run_id) THEN
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='COMMAND_IDENTITY_CONFLICT';
        END IF;
        target_state:='dispatched';
    ELSE target_state:=CASE WHEN p_result='uncertain' THEN 'uncertain' ELSE 'pending' END;
    END IF;
    delay_seconds:=CASE WHEN item.generation=1 THEN 1 WHEN item.generation=2 THEN 5 ELSE 30 END;
    UPDATE ifpmic.delivery_attempts SET completed_at=clock_timestamp(),result=p_result,
       observed_run_id=binding.admitted_run_id,error_code=p_error_code
       WHERE command_id=p_command_id AND generation=p_generation AND completed_at IS NULL;
    UPDATE ifpmic.commands_outbox SET state=target_state,claim_token=NULL,claim_expires_at=NULL,
       next_attempt_at=clock_timestamp()+delay_seconds*interval '1 second',last_error=p_error_code,
       observed_run_id=binding.admitted_run_id,
       dispatched_at=CASE WHEN target_state='dispatched' THEN clock_timestamp() ELSE dispatched_at END
       WHERE command_id=p_command_id;
    RETURN jsonb_build_object('status',target_state,'affected',1);
END $$;
CREATE FUNCTION ifpmic.read_activation(p_job_id uuid,p_run_id text,p_build_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE binding ifpmic.execution_bindings; workspace ifpmic.workspace_intents;
BEGIN
    binding:=ifpmic.h2_scope(p_job_id,p_run_id,p_build_id,true);
    IF binding.admitted_run_id IS NULL THEN RETURN jsonb_build_object('status','wait','code','BINDING_NOT_ADMITTED'); END IF;
    -- Pending scope is the sole no-data exception; admitted calls require the fence.
    binding:=ifpmic.h2_scope(p_job_id,p_run_id,p_build_id);
    IF binding.state='quarantined' THEN RETURN jsonb_build_object('status','quarantined','code',binding.quarantine_code); END IF;
    SELECT * INTO workspace FROM ifpmic.workspace_intents WHERE job_id=p_job_id;
    IF workspace.state IS DISTINCT FROM 'READY' THEN RETURN jsonb_build_object('status','wait','code','WORKSPACE_NOT_READY'); END IF;
    RETURN jsonb_build_object('status','ready','job_id',p_job_id,'binding_sha256',binding.binding_sha256,
       'command_id',binding.create_command_id,'command_payload_sha256',binding.command_payload_sha256,
       'revision',(SELECT revision FROM ifpmic.jobs WHERE job_id=p_job_id),
       'workspace_token',workspace.workspace_token,'workspace_generation',workspace.generation);
END $$;
CREATE FUNCTION ifpmic.project_activation(p_job_id uuid,p_run_id text,p_build_id text,p_transition_sequence bigint,
    p_expected_revision bigint,p_command_id uuid,p_proposal_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE binding ifpmic.execution_bindings; receipt ifpmic.projection_receipts; job_value ifpmic.jobs;
    cmd ifpmic.commands; workspace ifpmic.workspace_intents; catalog ifpmic.profile_catalog;
    expected_hash text; code_value text; answer jsonb; instant timestamptz;
BEGIN
    binding:=ifpmic.h2_scope(p_job_id,p_run_id,p_build_id);
    expected_hash:=ifpmic.h2_digest('ifpmic.b03.transition.v1',jsonb_build_object(
       'protocol_version','h2-v1','kind','activate_create','job_id',p_job_id::text,'run_id',p_run_id,
       'build_id',p_build_id,'binding_sha256',binding.binding_sha256,'transition_sequence',1,
       'expected_revision',0,'command_id',binding.create_command_id::text,
       'command_payload_sha256',binding.command_payload_sha256));
    IF p_transition_sequence IS DISTINCT FROM 1 OR p_expected_revision IS DISTINCT FROM 0
       OR p_command_id IS DISTINCT FROM binding.create_command_id OR p_proposal_sha256 IS DISTINCT FROM expected_hash THEN
        PERFORM ifpmic.h2_lock_job(p_job_id);
        PERFORM ifpmic.h2_quarantine(p_job_id,'PROPOSAL_COLLISION');
        RETURN jsonb_build_object('status','quarantined','code','PROPOSAL_COLLISION');
    END IF;
    SELECT * INTO receipt FROM ifpmic.projection_receipts WHERE job_id=p_job_id AND transition_sequence=p_transition_sequence;
    IF FOUND THEN
        IF ROW(receipt.command_id,receipt.admitted_run_id::text,receipt.build_id,receipt.proposal_sha256,receipt.expected_revision)
          IS DISTINCT FROM ROW(p_command_id,p_run_id,p_build_id,p_proposal_sha256,p_expected_revision) THEN
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='PROPOSAL_COLLISION';
        END IF;
        RETURN receipt.result_json;
    END IF;
    PERFORM ifpmic.h2_lock_job(p_job_id);
    SELECT * INTO receipt FROM ifpmic.projection_receipts WHERE job_id=p_job_id AND transition_sequence=p_transition_sequence;
    IF FOUND THEN
        IF ROW(receipt.command_id,receipt.admitted_run_id::text,receipt.build_id,receipt.proposal_sha256,receipt.expected_revision)
          IS DISTINCT FROM ROW(p_command_id,p_run_id,p_build_id,p_proposal_sha256,p_expected_revision) THEN
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='PROPOSAL_COLLISION';
        END IF;
        RETURN receipt.result_json;
    END IF;
    SELECT * INTO binding FROM ifpmic.execution_bindings WHERE job_id=p_job_id;
    IF binding.state='quarantined' THEN RETURN jsonb_build_object('status','quarantined','code',binding.quarantine_code); END IF;
    SELECT * INTO job_value FROM ifpmic.jobs WHERE job_id=p_job_id;
    SELECT * INTO cmd FROM ifpmic.commands WHERE command_id=p_command_id;
    IF job_value.status<>'DRAFT' OR job_value.revision<>0 OR job_value.cycle<>0 OR cardinality(job_value.current_step_ids)<>0
        OR cmd.status<>'accepted' THEN
        PERFORM ifpmic.h2_quarantine(p_job_id,'PREDECESSOR_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','PREDECESSOR_CONFLICT');
    END IF;
    -- G5 locks only its intent and never waits for a job/guard; taking SHARE
    -- after the binding serializes READY validation without a reverse lock edge.
    SELECT * INTO workspace FROM ifpmic.workspace_intents WHERE job_id=p_job_id FOR SHARE;
    IF workspace.state IS DISTINCT FROM 'READY' THEN RETURN jsonb_build_object('status','wait','code','WORKSPACE_NOT_READY'); END IF;
    IF workspace.command_id IS DISTINCT FROM p_command_id OR workspace.workspace_token IS DISTINCT FROM binding.workspace_token
        OR workspace.generation IS DISTINCT FROM binding.workspace_generation THEN
        PERFORM ifpmic.h2_quarantine(p_job_id,'WORKSPACE_IDENTITY_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','WORKSPACE_IDENTITY_CONFLICT');
    END IF;
    catalog:=ifpmic.h2_catalog(p_job_id);
    IF catalog.snapshot_id IS NULL OR catalog.record_bytes_sha256 IS DISTINCT FROM binding.catalog_record_sha256 THEN
        PERFORM ifpmic.h2_quarantine(p_job_id,'CATALOG_IDENTITY_CONFLICT');
        RETURN jsonb_build_object('status','quarantined','code','CATALOG_IDENTITY_CONFLICT');
    END IF;
    instant:=clock_timestamp();
    IF NOT EXISTS(SELECT 1 FROM ifpmic.memberships WHERE project_id=job_value.project_id AND user_id=job_value.owner_id
       AND active AND 'request.create'=ANY(capabilities)) THEN code_value:='FORBIDDEN';
    ELSIF NOT catalog.enabled OR NOT catalog.configuration_complete OR NOT EXISTS (
       SELECT 1 FROM ifpmic.profile_eligibility e WHERE e.project_id=job_value.project_id AND e.snapshot_id=job_value.snapshot_id
       AND e.mode=catalog.mode AND e.granted_at<=instant AND e.expires_at>instant AND NOT EXISTS (
          SELECT 1 FROM ifpmic.profile_revocations r WHERE r.project_id=e.project_id AND r.eligibility_id=e.eligibility_id)) THEN
        code_value:='PROFILE_INELIGIBLE';
    END IF;
    IF code_value IS NULL THEN
        UPDATE ifpmic.jobs SET status='QUEUED',revision=1 WHERE job_id=p_job_id;
        UPDATE ifpmic.commands SET status='applied',applied_revision=1 WHERE command_id=p_command_id;
        answer:=jsonb_build_object('status','applied','command_id',p_command_id,'applied_revision',1,
            'error_code',NULL,'job_id',p_job_id,'job_status','QUEUED','revision',1);
    ELSE
        UPDATE ifpmic.commands SET status='rejected',applied_revision=NULL,error_code=code_value WHERE command_id=p_command_id;
        answer:=jsonb_build_object('status','rejected','command_id',p_command_id,'applied_revision',NULL,
            'error_code',code_value,'job_id',p_job_id,'job_status','DRAFT','revision',0);
    END IF;
    INSERT INTO ifpmic.projection_receipts(job_id,transition_sequence,command_id,admitted_run_id,build_id,
        proposal_sha256,expected_revision,outcome,result_json)
      VALUES(p_job_id,p_transition_sequence,p_command_id,binding.admitted_run_id,p_build_id,
        p_proposal_sha256,p_expected_revision,answer->>'status',answer);
    RETURN answer;
END $$;
CREATE FUNCTION ifpmic.report_dispatch_incident(p_command_id uuid,p_generation bigint,p_claim_token uuid,p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE me ifpmic.worker_principals; binding ifpmic.execution_bindings; item ifpmic.commands_outbox;
BEGIN
    me:=ifpmic.h2_identity('dispatcher');
    SELECT b.* INTO binding FROM ifpmic.execution_bindings b JOIN ifpmic.commands c ON c.job_id=b.job_id
      WHERE c.command_id=p_command_id AND b.deployment_id=me.deployment_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
    PERFORM ifpmic.h2_lock_job(binding.job_id);
    SELECT * INTO item FROM ifpmic.commands_outbox WHERE command_id=p_command_id FOR UPDATE;
    IF item.state IS DISTINCT FROM 'leased' OR item.generation IS DISTINCT FROM p_generation
      OR item.claim_token IS DISTINCT FROM p_claim_token OR item.claim_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('status','stale','affected',0,'code','CLAIM_STALE');
    END IF;
    PERFORM ifpmic.h2_quarantine(binding.job_id,p_code);
    RETURN jsonb_build_object('status','quarantined','code',p_code);
END $$;
CREATE FUNCTION ifpmic.report_projection_incident(p_job_id uuid,p_run_id text,p_build_id text,p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
BEGIN
    PERFORM ifpmic.h2_scope(p_job_id,p_run_id,p_build_id);
    PERFORM ifpmic.h2_lock_job(p_job_id);
    PERFORM ifpmic.h2_quarantine(p_job_id,p_code);
    RETURN jsonb_build_object('status','quarantined','code',p_code);
END $$;

-- Default function privileges do not protect future definitions: revoke in the
-- same owner transaction, then grant the exact public surface and nothing else.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ifpmic FROM PUBLIC;
REVOKE ALL ON ifpmic.execution_role_config,ifpmic.execution_deployments,ifpmic.engine_builds,
    ifpmic.worker_principals,ifpmic.execution_bindings,ifpmic.worker_run_scopes,
    ifpmic.delivery_attempts,ifpmic.projection_receipts FROM PUBLIC,{runtime_role},{operator_role},{dispatcher_role},{projector_role};
GRANT USAGE ON SCHEMA ifpmic TO {dispatcher_role},{projector_role};
GRANT EXECUTE ON FUNCTION ifpmic.read_dispatch_config(),ifpmic.claim_delivery(uuid),
    ifpmic.reserve_execution(uuid,bigint,uuid,text,uuid,bigint),
    ifpmic.record_start_attempt(uuid,bigint,uuid,bigint),ifpmic.admit_run(uuid,bigint,uuid,text,text),
    ifpmic.record_delivery(uuid,bigint,uuid,text,text,text),ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)
    TO {dispatcher_role};
GRANT EXECUTE ON FUNCTION ifpmic.read_registered_build(text),ifpmic.read_activation(uuid,text,text),
    ifpmic.project_activation(uuid,text,text,bigint,bigint,uuid,text),
    ifpmic.report_projection_incident(uuid,text,text,text) TO {projector_role};
