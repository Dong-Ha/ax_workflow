-- Append-only H2 amendment: quarantine an invalid READY delivery before reserve.
-- Filesystem validation remains the trusted dispatcher's responsibility.
CREATE OR REPLACE FUNCTION ifpmic.report_dispatch_incident(
    p_command_id uuid,p_generation bigint,p_claim_token uuid,p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE
    me ifpmic.worker_principals;
    cmd ifpmic.commands;
    job_value ifpmic.jobs;
    binding ifpmic.execution_bindings;
    workspace ifpmic.workspace_intents;
    item ifpmic.commands_outbox;
    has_binding boolean;
    changed bigint;
BEGIN
    me:=ifpmic.h2_identity('dispatcher');
    SELECT * INTO cmd FROM ifpmic.commands WHERE command_id=p_command_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;

    -- Principal -> project guard -> membership NOWAIT -> job -> binding ->
    -- workspace -> target outbox. A concurrent first reservation is serialized
    -- by the job lock, so deciding the branch before this lock is incorrect.
    PERFORM ifpmic.h2_lock_job(cmd.job_id);
    SELECT * INTO binding FROM ifpmic.execution_bindings WHERE job_id=cmd.job_id;
    has_binding:=FOUND;
    IF has_binding AND binding.deployment_id IS DISTINCT FROM me.deployment_id THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;

    SELECT * INTO item FROM ifpmic.commands_outbox WHERE command_id=p_command_id FOR UPDATE;
    -- Sample expiry only after all lock waits, using the database's fresh clock.
    IF NOT FOUND OR item.state IS DISTINCT FROM 'leased'
       OR item.generation IS DISTINCT FROM p_generation
       OR item.claim_token IS DISTINCT FROM p_claim_token
       OR item.claim_expires_at IS NULL OR item.claim_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('status','stale','affected',0,'code','CLAIM_STALE');
    END IF;

    IF has_binding THEN
        -- Preserve 003's bound incident allowlist and job-wide quarantine.
        PERFORM ifpmic.h2_quarantine(binding.job_id,p_code);
        RETURN jsonb_build_object('status','quarantined','code',p_code);
    END IF;

    -- No binding grants no job-wide incident authority. Re-read mutable state
    -- after serialization and constrain this capability to the original CREATE.
    SELECT * INTO cmd FROM ifpmic.commands WHERE command_id=p_command_id;
    SELECT * INTO job_value FROM ifpmic.jobs WHERE job_id=cmd.job_id;
    IF NOT EXISTS(SELECT 1 FROM ifpmic.execution_deployments
                  WHERE deployment_id=me.deployment_id AND enabled)
       OR cmd.route IS DISTINCT FROM 'POST /api/v1/jobs'
       OR job_value.create_command_id IS DISTINCT FROM cmd.command_id
       OR job_value.project_id IS DISTINCT FROM cmd.project_id
       OR job_value.owner_id IS DISTINCT FROM cmd.actor_id
       OR cmd.status IS DISTINCT FROM 'accepted'
       OR job_value.status IS DISTINCT FROM 'DRAFT'
       OR job_value.revision IS DISTINCT FROM 0
       OR job_value.cycle IS DISTINCT FROM 0
       OR cardinality(job_value.current_step_ids) IS DISTINCT FROM 0
       OR job_value.candidate_fingerprint IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;
    IF p_code IS DISTINCT FROM 'WORKSPACE_IDENTITY_CONFLICT' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='INVALID_INCIDENT_CODE';
    END IF;
    SELECT * INTO workspace FROM ifpmic.workspace_intents WHERE job_id=cmd.job_id;
    IF NOT FOUND OR workspace.command_id IS DISTINCT FROM cmd.command_id THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;
    IF workspace.state IS DISTINCT FROM 'READY' THEN
        RETURN jsonb_build_object('status','wait','code','WORKSPACE_NOT_READY');
    END IF;

    -- The outbox lock serializes all trusted attempt writers. No binding, scope,
    -- receipt, job, command, workspace, authority or sibling row is changed.
    UPDATE ifpmic.delivery_attempts SET completed_at=clock_timestamp(),
        result='quarantined',error_code='WORKSPACE_IDENTITY_CONFLICT'
      WHERE command_id=p_command_id AND generation=p_generation
        AND completed_at IS NULL AND result IS NULL;
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<>1 THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
    END IF;
    UPDATE ifpmic.commands_outbox SET state='quarantined',claim_token=NULL,
        claim_expires_at=NULL,last_error='WORKSPACE_IDENTITY_CONFLICT'
      WHERE command_id=p_command_id;
    RETURN jsonb_build_object('status','quarantined','code','WORKSPACE_IDENTITY_CONFLICT');
END $$;

-- Replacement, PUBLIC denial and exact service grant share the migrator's
-- owner transaction. Existing helper/table privileges remain unchanged.
REVOKE ALL ON FUNCTION ifpmic.report_dispatch_incident(uuid,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ifpmic.report_dispatch_incident(uuid,bigint,uuid,text) TO {dispatcher_role};
