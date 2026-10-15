"""Static design validation, not a production service or acceptance test runner."""
from pathlib import Path
import json
from collections import deque

root=Path(__file__).parent
spec=root/'specs'
load=lambda name:json.loads((spec/name).read_text(encoding='utf-8'))
w=load('workflow.v1.json');nodes={n['id']:n for n in w['nodes']}
checks=[]
def check(name,ok,detail=''):
    checks.append(dict(name=name,passed=bool(ok),detail=detail))

check('unique_nodes',len(nodes)==len(w['nodes']))
check('all_original_steps_present',set(f'P{i:02}' for i in range(1,27)).issubset(nodes))
check('known_roles',all(n['owner'] in w['roles'] for n in nodes.values()))
for key in ['on_pass','on_business_fail']:
    check('valid_'+key,all(n[key] is None or n[key] in nodes or n[key]=='END' for n in nodes.values()))
path=[];current=w['start']
while current not in path and current!='END':
    path.append(current);current=nodes[current]['on_pass']
check('success_path_reaches_end',current=='END')
check('success_path_covers_all_nodes',set(path)==set(nodes))
check('human_boundaries_preserved',all(nodes[i]['owner']=='human' for i in ['P06','P07','P08','P10','P21','X01','X03']))
check('tc_scope_preserved',nodes['P09']['owner']=='tc' and nodes['P12']['owner']=='tc')
check('sam_failure_returns_design',nodes['P16']['on_business_fail']=='P07')
check('tem_and_static_failure_return_development',all(nodes[i]['on_business_fail']=='P11' for i in ['P18','P20']))
check('sqe_report_before_gate',nodes['P22']['on_pass']=='P23' and nodes['P23']['on_pass']=='P24')
check('sqe_failure_returns_design',nodes['P24']['on_business_fail']=='P07')
check('release_notes_original_order',nodes['P25']['on_pass']=='P26')

# Graph search: no path to remote release may bypass human release approval,
# including business-failure edges and explicit reject/reconciliation branches.
edges={n['id']:[v for v in [n['on_pass'],n['on_business_fail']] if v] for n in nodes.values()}
for k,v in w['special_outcomes'].items():
    if v in nodes:edges[k.split('.')[0]].append(v)
def reachable(start,blocked=set()):
    seen=set();todo=[start]
    while todo:
        node=todo.pop()
        if node in seen or node in blocked:continue
        seen.add(node);todo.extend(edges.get(node,[]))
    return seen
check('approval_dominates_release','P25' not in reachable('P01',{'X03'}))
check('approval_cannot_skip',nodes['X03']['skip_policy']=='NEVER')
check('final_manifest_precedes_approval',nodes['X02']['on_pass']=='X03')

# Walk a single failure followed by a passing cycle; ensure the return path
# crosses the required human work, development and downstream quality checks.
for gate,required in [('P16',['P07','P08','P11','P13','P15','P16']),('P18',['P11','P13','P15','P17','P18']),('P20',['P11','P13','P15','P19','P20']),('P24',['P07','P08','P11','P15','P22','P23','P24'])]:
    return_path=[];cur=nodes[gate]['on_business_fail']
    while cur not in return_path and cur!='END':
        return_path.append(cur)
        if cur==gate:break
        cur=nodes[cur]['on_pass']
    check(gate+'_rework_path',all(x in return_path for x in required),','.join(return_path))

state=load('state-contract.json')['step_transitions']
check('all_step_states_defined',set(state)==set(w['states']))
check('state_targets_exist',all(t in state for ts in state.values() for t in ts))
check('canceled_is_terminal',state['CANCELED']==[])
check('unknown_side_effect_reconciles','RECONCILING' in state['RUNNING'])
check('side_effects_not_blindly_retried',set(['flash','remote_push','create_pr','create_tag']).issubset(w['non_retryable_without_reconciliation']))

api=load('openapi.v1.json');schema=api['components']['schemas']
refs=[]
def visit(value):
    if isinstance(value,dict):
        if '$ref' in value:refs.append(value['$ref'])
        for v in value.values():visit(v)
    elif isinstance(value,list):
        for v in value:visit(v)
visit(api)
check('api_refs_resolve',all(r.startswith('#/components/schemas/') and r.rsplit('/',1)[1] in schema for r in refs))
ops=[o for p in api['paths'].values() for o in p.values()]
check('api_unique_operation_ids',len({o['operationId'] for o in ops})==len(ops))
check('api_writes_idempotent',all(any(p['name']=='Idempotency-Key' and p['required'] for p in o.get('parameters',[])) for p in api['paths'].values() for m,o in p.items() if m in ['post','put']))
check('approval_payload_binds_manifest','manifest_sha256' in schema['ApprovalDecision']['required'])
check('human_payload_revision_guard','expected_revision' in schema['HumanSubmission']['required'])
check('job_owner_not_client_supplied','owner_id' not in schema['CreateJob']['properties'])
check('sse_recovery_contract','410' in api['paths']['/api/v1/jobs/{job_id}/events']['get']['responses'])
try:
    import jsonschema
    for name,s in schema.items():jsonschema.Draft202012Validator.check_schema(s)
    check('json_schema_meta_validation',True,str(len(schema))+' component schemas')
except Exception as exc:check('json_schema_meta_validation',False,str(exc))

req=load('requirements.json');cases=load('acceptance-cases.json');caseids={c['id'] for c in cases}
check('all_user_requirements_map_to_acceptance',all(r['acceptance'] in caseids for r in req))
check('acceptance_not_mislabeled_passed',all(c['status']=='not_executed' for c in cases))
backlog=load('implementation-backlog.json');done=set()
for b in backlog:
    check(b['id']+'_dependencies',set(b['depends_on']).issubset(done));done.add(b['id'])
check('backlog_test_links_valid',all(c in caseids for b in backlog for c in b['acceptance']))
profile=load('project-profile.example.json')
check('example_profile_not_live',profile['enabled'] is False and profile['mode']=='mock')
bridge=load('bridge-contract.json')
check('bridge_command_has_identity_and_fence',{'command_id','device_id','fencing_token','lease_id'}.issubset(bridge['command_fields']))
check('release_mode_consistency',w['release_modes']==schema['CreateJob']['properties']['release_mode']['enum']==schema['ReleaseManifest']['properties']['mode']['enum'])
report={'kind':'static_design_validation','not_production_acceptance':True,'checks':checks,'summary':{'passed':sum(c['passed'] for c in checks),'total':len(checks),'failed':[c['name'] for c in checks if not c['passed']]},'inventory':{'original_nodes':26,'extension_nodes':3,'requirements':len(req),'acceptance_cases':len(cases),'api_paths':len(api['paths']),'api_operations':len(ops),'component_schemas':len(schema),'backlog_items':len(backlog)}}
(root/'qa'/'design-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report['summary'],ensure_ascii=False))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
