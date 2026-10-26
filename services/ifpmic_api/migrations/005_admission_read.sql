-- One bounded read capability. The shared API authenticates the browser actor
-- and applies VISIBLE in the same statement; session_user is not that actor.
-- The existing migration/schema owner remains privileged. No new role or table
-- privilege is granted to the API or workers.
CREATE FUNCTION ifpmic.read_job_admission(p_job_id uuid)
RETURNS TABLE(job_id uuid, project_id text, create_command_id uuid, owner_id uuid, admission jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,ifpmic,pg_temp AS $$
WITH source AS (
    SELECT j.job_id,j.project_id,j.create_command_id,j.owner_id,j.status AS job_status,j.revision,
        c.command_id,c.project_id AS command_project,c.job_id AS command_job,c.actor_id,c.route,
        c.status AS command_status,c.applied_revision,c.error_code,
        b.job_id AS binding_job,b.project_id AS binding_project,b.create_command_id AS binding_command,
        b.state AS binding_state,b.admitted_run_id,b.quarantine_code,
        o.command_id AS outbox_command,o.state AS outbox_state,o.generation,o.last_error,
        o.observed_run_id AS outbox_run,
        a.command_id AS attempt_command,a.completed_at,a.result AS attempt_result,a.observed_run_id AS attempt_run,
        r.job_id AS receipt_job,r.command_id AS receipt_command,r.admitted_run_id AS receipt_run,
        r.expected_revision,r.outcome,r.result_json
    FROM ifpmic.jobs j
    LEFT JOIN ifpmic.commands c ON c.command_id=j.create_command_id
    LEFT JOIN ifpmic.execution_bindings b ON b.job_id=j.job_id
    LEFT JOIN ifpmic.commands_outbox o ON o.command_id=j.create_command_id
    LEFT JOIN ifpmic.delivery_attempts a ON a.command_id=o.command_id AND a.generation=o.generation
    LEFT JOIN ifpmic.projection_receipts r ON r.job_id=j.job_id AND r.transition_sequence=1
    WHERE j.job_id=p_job_id
), checked AS (
    SELECT s.*,
        command_id=create_command_id AND command_project=project_id AND command_job=job_id
        AND actor_id=owner_id AND route='POST /api/v1/jobs' AND outbox_command=command_id
        AND (binding_job IS NULL OR (binding_project=project_id AND binding_command=command_id))
        AND (quarantine_code IS NULL OR quarantine_code IN (
            'BINDING_CONFLICT','BUILD_UNAVAILABLE','RUN_CONFLICT','HISTORY_MISSING',
            'START_WINDOW_EXPIRED','RETENTION_UNVERIFIED','WORKSPACE_IDENTITY_CONFLICT',
            'CATALOG_IDENTITY_CONFLICT','PROPOSAL_COLLISION','PREDECESSOR_CONFLICT','COMMAND_IDENTITY_CONFLICT'))
        AND (outbox_run IS NULL OR outbox_run=admitted_run_id)
        AND (attempt_run IS NULL OR attempt_run=admitted_run_id)
        AND ((generation=0 AND outbox_state='pending' AND attempt_command IS NULL AND outbox_run IS NULL)
          OR (generation>0 AND attempt_command=command_id AND (
              (outbox_state='leased' AND completed_at IS NULL AND attempt_result IS NULL)
              OR (completed_at IS NOT NULL AND (
                  (outbox_state='pending' AND attempt_result='retry')
                  OR (outbox_state='uncertain' AND attempt_result='uncertain')
                  OR (outbox_state='dispatched' AND attempt_result IN ('started','receipt_reconciled')
                      AND outbox_run=admitted_run_id AND attempt_run=admitted_run_id)
                  OR (outbox_state='quarantined' AND attempt_result IN ('quarantined','retry','uncertain','expired'))
              ))
          ))) AS consistent,
        command_status='accepted' AND applied_revision IS NULL AND error_code IS NULL
            AND job_status='DRAFT' AND revision=0 AS initial_state,
        receipt_job=job_id AND receipt_command=command_id AND receipt_run=admitted_run_id
            AND binding_state IN ('admitted','closed','quarantined') AND expected_revision=0 AS receipt_identity
    FROM source s
), classified AS (
    SELECT c.*, CASE WHEN consistent THEN CASE
        -- Exact object equality validates all seven keys, types and values.
        -- Immutable receipt wins over a later binding quarantine.
        WHEN receipt_identity AND outcome='applied' AND command_status='applied'
            AND applied_revision=1 AND error_code IS NULL AND revision>=1
            AND result_json=pg_catalog.jsonb_build_object('status','applied','command_id',command_id,
                'applied_revision',1,'error_code',NULL,'job_id',job_id,'job_status','QUEUED','revision',1)
            THEN 'applied'
        WHEN receipt_identity AND outcome='rejected'
            AND command_status='rejected' AND applied_revision IS NULL
            AND job_status='DRAFT' AND revision=0 AND error_code IN ('FORBIDDEN','PROFILE_INELIGIBLE')
            AND result_json=pg_catalog.jsonb_build_object('status','rejected','command_id',command_id,
                'applied_revision',NULL,'error_code',error_code,'job_id',job_id,'job_status','DRAFT','revision',0)
            THEN 'rejected'
        WHEN receipt_job IS NULL AND initial_state THEN CASE
            WHEN (binding_job IS NULL OR binding_state='reserved') AND admitted_run_id IS NULL
                AND outbox_state IN ('pending','leased','uncertain') THEN 'pending'
            WHEN binding_state='admitted' AND admitted_run_id IS NOT NULL
                AND outbox_state IN ('pending','leased','uncertain','dispatched') THEN 'admitted_pending_projection'
            WHEN binding_job IS NULL AND outbox_state='quarantined'
                AND last_error='WORKSPACE_IDENTITY_CONFLICT' THEN 'quarantined'
            WHEN binding_state='quarantined' AND quarantine_code IS NOT NULL
                AND ((outbox_state='quarantined' AND last_error=quarantine_code) OR outbox_state='dispatched')
                THEN 'quarantined'
        END
    END END AS admission_status
    FROM checked c
)
SELECT c.job_id,c.project_id,c.create_command_id,c.owner_id,
    CASE WHEN c.admission_status IS NOT NULL THEN pg_catalog.jsonb_build_object(
        'schema_version','ifpmic.admission-status.v1',
        'job_id',c.job_id,'command_id',c.command_id,'admission_status',c.admission_status,
        'job_status',c.job_status,'job_revision',c.revision,'command_status',c.command_status,
        'applied_revision',c.applied_revision,'admitted_run_id',c.admitted_run_id,
        'receipt',CASE WHEN c.admission_status IN ('applied','rejected') THEN pg_catalog.jsonb_build_object(
            'transition_sequence',1,'outcome',c.outcome,'expected_revision',0,
            'applied_revision',c.applied_revision,
            'projected_job_status',CASE WHEN c.outcome='applied' THEN 'QUEUED' ELSE 'DRAFT' END,
            'projected_revision',CASE WHEN c.outcome='applied' THEN 1 ELSE 0 END) ELSE NULL END,
        'error_code',CASE WHEN c.admission_status='quarantined' THEN
            CASE WHEN c.binding_job IS NULL THEN c.last_error ELSE c.quarantine_code END ELSE c.error_code END)
    ELSE NULL END
FROM classified c
$$;
REVOKE ALL ON FUNCTION ifpmic.read_job_admission(uuid) FROM PUBLIC, {operator_role}, {dispatcher_role}, {projector_role};
GRANT EXECUTE ON FUNCTION ifpmic.read_job_admission(uuid) TO {runtime_role};
