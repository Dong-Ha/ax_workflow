-- Immutable storage and a bounded read capability for mock task results.
-- Writers are intentionally deferred to a later migration.
CREATE TABLE ifpmic.mock_task_results (
    job_id uuid PRIMARY KEY,
    command_id uuid NOT NULL,
    admitted_run_id uuid NOT NULL,
    build_id text NOT NULL CHECK (build_id ~ '^[0-9a-f]{{64}}$'),
    task_kind text NOT NULL CHECK (task_kind='request-preflight-v1'),
    result_json jsonb NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT mock_result_shape CHECK ((
        pg_catalog.jsonb_typeof(result_json)='object'
        AND pg_catalog.jsonb_typeof(result_json->'result_sha256')='string'
        AND result_json->>'result_sha256' ~ '^[0-9a-f]{{64}}$'
        AND result_json=pg_catalog.jsonb_build_object(
            'task_kind','request-preflight-v1','mode','mock','outcome','passed',
            'checks',pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object('name','request_saved','status','passed'),
                pg_catalog.jsonb_build_object('name','workspace_ready','status','passed'),
                pg_catalog.jsonb_build_object('name','engine_admitted','status','passed')),
            'result_sha256',result_json->'result_sha256')) IS TRUE),
    FOREIGN KEY(command_id,job_id) REFERENCES ifpmic.jobs(create_command_id,job_id),
    FOREIGN KEY(job_id,admitted_run_id) REFERENCES ifpmic.execution_bindings(job_id,admitted_run_id)
);

CREATE FUNCTION ifpmic.read_job_mock_task(p_job_id uuid)
RETURNS TABLE(job_id uuid,project_id text,create_command_id uuid,owner_id uuid,mock_task jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
WITH source AS (
    SELECT j.job_id,j.project_id,j.create_command_id,j.owner_id,
      c.command_id,c.actor_id,c.route,c.status AS command_status,c.applied_revision,
      b.job_id AS binding_job,b.project_id AS binding_project,b.create_command_id AS binding_command,
      b.admitted_run_id,b.state AS binding_state,b.build_id,
      b.workspace_token,b.workspace_generation,pc.mode,
      w.job_id AS workspace_job,w.command_id AS workspace_command,w.workspace_token AS actual_workspace_token,
      w.generation AS actual_workspace_generation,w.state AS workspace_state,
      r.job_id AS receipt_job,r.transition_sequence,r.command_id AS receipt_command,
      r.admitted_run_id AS receipt_run,r.build_id AS receipt_build,r.outcome,r.expected_revision,
      m.job_id AS result_job,m.command_id AS result_command,m.admitted_run_id AS result_run,
      m.build_id AS result_build,m.task_kind,m.result_json,m.completed_at,
      a.job_id AS admission_job,a.project_id AS admission_project,a.create_command_id AS admission_command,
      a.owner_id AS admission_owner,a.admission
    FROM ifpmic.jobs j
    LEFT JOIN ifpmic.commands c ON c.command_id=j.create_command_id AND c.job_id=j.job_id
      AND c.project_id=j.project_id AND c.route='POST /api/v1/jobs'
    LEFT JOIN ifpmic.execution_bindings b ON b.job_id=j.job_id
    LEFT JOIN ifpmic.profile_catalog pc ON pc.project_id=j.project_id AND pc.snapshot_id=j.snapshot_id
    LEFT JOIN ifpmic.workspace_intents w ON w.job_id=j.job_id
    LEFT JOIN ifpmic.projection_receipts r ON r.job_id=j.job_id AND r.transition_sequence=1
    LEFT JOIN ifpmic.mock_task_results m ON m.job_id=j.job_id
    LEFT JOIN LATERAL ifpmic.read_job_admission(j.job_id) a ON true
    WHERE j.job_id=p_job_id
), classified AS (
    SELECT s.*,
      (admission_job=job_id AND admission_project=project_id
        AND admission_command=create_command_id AND admission_owner=owner_id
        AND admission->>'job_id'=job_id::text AND admission->>'command_id'=create_command_id::text
        AND admission->>'admission_status' IN ('pending','admitted_pending_projection','applied','rejected','quarantined')) AS admission_valid,
      (command_id=create_command_id AND actor_id=owner_id AND route='POST /api/v1/jobs'
        AND command_status='applied' AND applied_revision=1
        AND binding_job=job_id AND binding_project=project_id AND binding_command=create_command_id
        AND admitted_run_id IS NOT NULL AND binding_state IN ('admitted','closed') AND mode='mock'
        AND build_id ~ '^[0-9a-f]{{64}}$'
        AND workspace_job=job_id AND workspace_command=create_command_id
        AND workspace_state='READY' AND actual_workspace_token=workspace_token
        AND actual_workspace_generation=workspace_generation AND workspace_generation>=0
        AND receipt_job=job_id AND transition_sequence=1 AND receipt_command=create_command_id
        AND receipt_run=admitted_run_id AND receipt_build=build_id AND outcome='applied'
        AND expected_revision=0
        AND admission->>'admission_status'='applied'
        AND result_job=job_id AND result_command=create_command_id
        AND result_run=admitted_run_id AND result_build=build_id AND task_kind='request-preflight-v1'
        AND pg_catalog.jsonb_typeof(result_json)='object'
        AND pg_catalog.jsonb_typeof(result_json->'result_sha256')='string'
        AND result_json->>'result_sha256' ~ '^[0-9a-f]{{64}}$'
        AND result_json=pg_catalog.jsonb_build_object(
          'task_kind','request-preflight-v1','mode','mock','outcome','passed',
          'checks',pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('name','request_saved','status','passed'),
            pg_catalog.jsonb_build_object('name','workspace_ready','status','passed'),
            pg_catalog.jsonb_build_object('name','engine_admitted','status','passed')),'result_sha256',result_json->'result_sha256')) AS result_valid
      FROM source s
)
SELECT job_id,project_id,create_command_id,owner_id,
  CASE WHEN admission_valid AND (result_job IS NULL OR result_valid) THEN
    pg_catalog.jsonb_build_object('schema_version','ifpmic.mock-task.v1',
      'job_id',job_id,'command_id',create_command_id,
      'admitted_run_id',CASE WHEN result_job IS NULL THEN NULL ELSE result_run END,
      'status',CASE WHEN result_job IS NULL THEN 'pending' ELSE 'completed' END,
      'result',CASE WHEN result_job IS NULL THEN NULL ELSE result_json END,
      'completed_at',CASE WHEN result_job IS NULL THEN NULL ELSE
        pg_catalog.to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END)
    ELSE NULL END
FROM classified
$$;

REVOKE ALL ON TABLE ifpmic.mock_task_results FROM PUBLIC,{runtime_role},{operator_role},{dispatcher_role},{projector_role};
REVOKE ALL ON FUNCTION ifpmic.read_job_mock_task(uuid) FROM PUBLIC,{operator_role},{dispatcher_role},{projector_role};
GRANT EXECUTE ON FUNCTION ifpmic.read_job_mock_task(uuid) TO {runtime_role};
