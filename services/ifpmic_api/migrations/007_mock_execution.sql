-- Opt-in and a projector-only bounded mock preflight capability.
CREATE TABLE ifpmic.mock_task_builds (
    deployment_id text NOT NULL,
    build_id text NOT NULL,
    task_kind text NOT NULL DEFAULT 'request-preflight-v1' CHECK (task_kind='request-preflight-v1'),
    enabled boolean NOT NULL DEFAULT true,
    PRIMARY KEY(deployment_id,build_id),
    FOREIGN KEY(deployment_id,build_id) REFERENCES ifpmic.engine_builds(deployment_id,build_id)
);

CREATE FUNCTION ifpmic.mock_preflight_result(p_job_id uuid,p_command_id uuid,p_run_id uuid,p_build_id text)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,ifpmic,pg_temp AS $$
 SELECT pg_catalog.jsonb_build_object(
   'task_kind','request-preflight-v1','mode','mock','outcome','passed',
   'checks',pg_catalog.jsonb_build_array(
     pg_catalog.jsonb_build_object('name','request_saved','status','passed'),
     pg_catalog.jsonb_build_object('name','workspace_ready','status','passed'),
     pg_catalog.jsonb_build_object('name','engine_admitted','status','passed')),
   'result_sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
     ifpmic.h2_canonical(pg_catalog.jsonb_build_object(
       'schema_version','ifpmic.mock-task.v1','task_kind','request-preflight-v1','outcome','passed',
       'identity',pg_catalog.jsonb_build_object('job_id',p_job_id::text,'command_id',p_command_id::text,
         'admitted_run_id',p_run_id::text,'build_id',p_build_id))), 'UTF8')),'hex'))
$$;

CREATE FUNCTION ifpmic.read_mock_task_input(p_job_id uuid,p_run_id text,p_build_id text,p_binding_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE binding ifpmic.execution_bindings; me ifpmic.worker_principals; stored ifpmic.mock_task_results;
  j ifpmic.jobs; c ifpmic.commands; w ifpmic.workspace_intents; catalog ifpmic.profile_catalog;
  admission jsonb; payload jsonb; input_value jsonb; expected jsonb; instant timestamptz;
BEGIN
  binding:=ifpmic.h2_scope(p_job_id,p_run_id,p_build_id);
  IF binding.binding_sha256 IS DISTINCT FROM p_binding_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
  END IF;
  me:=ifpmic.h2_identity('projector');
  IF NOT EXISTS(SELECT 1 FROM ifpmic.mock_task_builds x WHERE x.deployment_id=me.deployment_id
      AND x.build_id=me.build_id AND x.task_kind='request-preflight-v1' AND x.enabled
      AND EXISTS(SELECT 1 FROM ifpmic.execution_deployments d WHERE d.deployment_id=x.deployment_id AND d.enabled)
      AND EXISTS(SELECT 1 FROM ifpmic.engine_builds b WHERE b.deployment_id=x.deployment_id AND b.build_id=x.build_id AND b.enabled)) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
  END IF;
  SELECT * INTO stored FROM ifpmic.mock_task_results WHERE job_id=p_job_id;
  IF FOUND THEN
    expected:=ifpmic.mock_preflight_result(p_job_id,binding.create_command_id,binding.admitted_run_id,p_build_id);
    IF stored.command_id IS DISTINCT FROM binding.create_command_id OR stored.admitted_run_id::text IS DISTINCT FROM p_run_id
       OR stored.build_id IS DISTINCT FROM p_build_id OR stored.task_kind IS DISTINCT FROM 'request-preflight-v1'
       OR stored.result_json IS DISTINCT FROM expected THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_RESULT_INVALID';
    END IF;
    RETURN pg_catalog.jsonb_build_object('status','completed');
  END IF;
  PERFORM ifpmic.h2_lock_job(p_job_id);
  SELECT * INTO stored FROM ifpmic.mock_task_results WHERE job_id=p_job_id;
  IF FOUND THEN
    expected:=ifpmic.mock_preflight_result(p_job_id,binding.create_command_id,binding.admitted_run_id,p_build_id);
    IF stored.command_id IS DISTINCT FROM binding.create_command_id OR stored.admitted_run_id::text IS DISTINCT FROM p_run_id
       OR stored.build_id IS DISTINCT FROM p_build_id OR stored.result_json IS DISTINCT FROM expected THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_RESULT_INVALID';
    END IF;
    RETURN pg_catalog.jsonb_build_object('status','completed');
  END IF;
  -- Admission reader is the canonical validation of the first applied receipt.
  SELECT a.admission INTO admission FROM ifpmic.read_job_admission(p_job_id) a
    WHERE a.job_id=p_job_id AND a.create_command_id=binding.create_command_id;
  SELECT * INTO j FROM ifpmic.jobs WHERE job_id=p_job_id;
  SELECT * INTO c FROM ifpmic.commands WHERE command_id=binding.create_command_id;
  SELECT * INTO w FROM ifpmic.workspace_intents WHERE job_id=p_job_id;
  catalog:=ifpmic.h2_catalog(p_job_id);
  instant:=clock_timestamp();
  IF admission->>'admission_status' IS DISTINCT FROM 'applied'
     OR binding.state IS DISTINCT FROM 'admitted'
     OR c.status IS DISTINCT FROM 'applied' OR c.applied_revision IS DISTINCT FROM 1
     OR j.status IS DISTINCT FROM 'QUEUED' OR j.revision IS DISTINCT FROM 1
     OR w.state IS DISTINCT FROM 'READY' OR w.command_id IS DISTINCT FROM binding.create_command_id
     OR w.workspace_token IS DISTINCT FROM binding.workspace_token
     OR w.generation IS DISTINCT FROM binding.workspace_generation
     OR catalog.snapshot_id IS NULL OR NOT catalog.enabled OR catalog.mode IS DISTINCT FROM 'mock'
     OR catalog.record_bytes_sha256 IS DISTINCT FROM binding.catalog_record_sha256 OR NOT catalog.configuration_complete
     OR NOT EXISTS(SELECT 1 FROM ifpmic.memberships m WHERE m.project_id=j.project_id AND m.user_id=j.owner_id
          AND m.active AND 'request.create'=ANY(m.capabilities))
     OR NOT EXISTS(SELECT 1 FROM ifpmic.projection_receipts r WHERE r.job_id=p_job_id
          AND r.transition_sequence=1 AND r.command_id=binding.create_command_id
          AND r.admitted_run_id=binding.admitted_run_id AND r.build_id=p_build_id AND r.outcome='applied')
     OR NOT EXISTS(SELECT 1 FROM ifpmic.profile_eligibility e WHERE e.project_id=j.project_id
          AND e.snapshot_id=j.snapshot_id AND e.mode=catalog.mode AND e.granted_at<=instant
          AND e.expires_at>instant AND NOT EXISTS(SELECT 1 FROM ifpmic.profile_revocations r
              WHERE r.project_id=e.project_id AND r.eligibility_id=e.eligibility_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_INPUT_NOT_READY';
  END IF;
  payload:=c.command_payload_json::jsonb;
  input_value:=pg_catalog.jsonb_build_object('job_id',p_job_id::text,'command_id',binding.create_command_id::text,
      'admitted_run_id',binding.admitted_run_id::text,'build_id',p_build_id,
      'change_type',payload->>'change_type','base_ref_present',coalesce(payload->>'base_ref','')<>'',
      'request_saved',true,'workspace_ready',true,'engine_admitted',true);
  IF pg_catalog.jsonb_typeof(payload->'change_type') IS DISTINCT FROM 'string'
      OR input_value->>'change_type' NOT IN ('NEW_HW','FEATURE','BUGFIX') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_INPUT_INVALID';
  END IF;
  RETURN pg_catalog.jsonb_build_object('status','ready','workspace_token',binding.workspace_token::text,'input',input_value);
END $$;

CREATE FUNCTION ifpmic.record_mock_task_result(p_job_id uuid,p_run_id text,p_build_id text,p_binding_sha256 text,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
DECLARE binding ifpmic.execution_bindings; me ifpmic.worker_principals; existing ifpmic.mock_task_results;
  input_value jsonb; expected jsonb;
BEGIN
  binding:=ifpmic.h2_scope(p_job_id,p_run_id,p_build_id);
  IF binding.binding_sha256 IS DISTINCT FROM p_binding_sha256 THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN'; END IF;
  me:=ifpmic.h2_identity('projector');
  IF NOT EXISTS(SELECT 1 FROM ifpmic.mock_task_builds x WHERE x.deployment_id=me.deployment_id
      AND x.build_id=me.build_id AND x.enabled AND x.task_kind='request-preflight-v1'
      AND EXISTS(SELECT 1 FROM ifpmic.execution_deployments d WHERE d.deployment_id=x.deployment_id AND d.enabled)
      AND EXISTS(SELECT 1 FROM ifpmic.engine_builds b WHERE b.deployment_id=x.deployment_id AND b.build_id=x.build_id AND b.enabled)) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='WORKER_FORBIDDEN';
  END IF;
  PERFORM ifpmic.h2_lock_job(p_job_id);
  SELECT * INTO existing FROM ifpmic.mock_task_results WHERE job_id=p_job_id;
  expected:=ifpmic.mock_preflight_result(p_job_id,binding.create_command_id,binding.admitted_run_id,p_build_id);
  IF FOUND THEN
    IF existing.command_id IS DISTINCT FROM binding.create_command_id OR existing.admitted_run_id::text IS DISTINCT FROM p_run_id
       OR existing.build_id IS DISTINCT FROM p_build_id OR existing.result_json IS DISTINCT FROM expected
       OR p_result IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_RESULT_CONFLICT'; END IF;
    RETURN pg_catalog.jsonb_build_object('status','completed');
  END IF;
  input_value:=ifpmic.read_mock_task_input(p_job_id,p_run_id,p_build_id,p_binding_sha256);
  IF input_value->>'status' IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_INPUT_NOT_READY';
  END IF;
  IF p_result IS DISTINCT FROM expected THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_RESULT_INVALID';
  END IF;
  INSERT INTO ifpmic.mock_task_results(job_id,command_id,admitted_run_id,build_id,task_kind,result_json)
    VALUES(p_job_id,binding.create_command_id,binding.admitted_run_id,p_build_id,'request-preflight-v1',expected)
    ON CONFLICT(job_id) DO NOTHING;
  SELECT * INTO existing FROM ifpmic.mock_task_results WHERE job_id=p_job_id;
  IF existing.command_id IS DISTINCT FROM binding.create_command_id OR existing.admitted_run_id::text IS DISTINCT FROM p_run_id
     OR existing.build_id IS DISTINCT FROM p_build_id OR existing.result_json IS DISTINCT FROM expected THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MOCK_RESULT_CONFLICT';
  END IF;
  RETURN pg_catalog.jsonb_build_object('status','completed');
END $$;

REVOKE ALL ON TABLE ifpmic.mock_task_builds FROM PUBLIC,{runtime_role},{operator_role},{dispatcher_role},{projector_role};
REVOKE ALL ON FUNCTION ifpmic.mock_preflight_result(uuid,uuid,uuid,text) FROM PUBLIC,{runtime_role},{operator_role},{dispatcher_role},{projector_role};
REVOKE ALL ON FUNCTION ifpmic.read_mock_task_input(uuid,text,text,text) FROM PUBLIC,{runtime_role},{operator_role},{dispatcher_role},{projector_role};
REVOKE ALL ON FUNCTION ifpmic.record_mock_task_result(uuid,text,text,text,jsonb) FROM PUBLIC,{runtime_role},{operator_role},{dispatcher_role},{projector_role};
GRANT EXECUTE ON FUNCTION ifpmic.read_mock_task_input(uuid,text,text,text),
  ifpmic.record_mock_task_result(uuid,text,text,text,jsonb) TO {projector_role};
