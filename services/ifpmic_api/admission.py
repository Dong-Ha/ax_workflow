"""Public admission DTO validation. Private SQL/history never crosses this boundary."""
from .errors import ApiError
from .request_contract import canonical_uuid

REJECTED_CODES = frozenset({'FORBIDDEN', 'PROFILE_INELIGIBLE'})
QUARANTINE_CODES = frozenset({
    'BINDING_CONFLICT', 'BUILD_UNAVAILABLE', 'RUN_CONFLICT', 'HISTORY_MISSING',
    'START_WINDOW_EXPIRED', 'RETENTION_UNVERIFIED', 'WORKSPACE_IDENTITY_CONFLICT',
    'CATALOG_IDENTITY_CONFLICT', 'PROPOSAL_COLLISION', 'PREDECESSOR_CONFLICT', 'COMMAND_IDENTITY_CONFLICT',
})
KEYS = frozenset({'schema_version', 'job_id', 'command_id', 'admission_status', 'job_status',
                  'job_revision', 'command_status', 'applied_revision', 'admitted_run_id', 'receipt', 'error_code'})


def validate_admission(value, *, job_id, command_id, job_statuses):
    def require(condition):
        if not condition:
            raise ApiError('DEPENDENCY_UNAVAILABLE')

    require(type(value) is dict and set(value) == KEYS)
    require(value['schema_version'] == 'ifpmic.admission-status.v1')
    require(value['job_id'] == str(job_id) and value['command_id'] == str(command_id))
    require(type(value['job_status']) is str and value['job_status'] in job_statuses)
    require(type(value['job_revision']) is int and value['job_revision'] >= 0)
    run = value['admitted_run_id']
    require(run is None or (type(run) is str and canonical_uuid(run)))
    phase = value['admission_status']
    require(type(phase) is str and phase in {'pending', 'admitted_pending_projection', 'applied', 'rejected', 'quarantined'})
    revision = value['applied_revision']
    require(revision is None or (type(revision) is int and revision >= 0))
    code = value['error_code']
    require(code is None or type(code) is str)
    if phase == 'applied':
        require(value['command_status'] == 'applied' and revision == 1 and code is None
                and run is not None and value['job_revision'] >= 1)
    else:
        require(value['job_status'] == 'DRAFT' and value['job_revision'] == 0 and revision is None)
        require(value['command_status'] == ('rejected' if phase == 'rejected' else 'accepted'))
    if phase in {'applied', 'rejected'}:
        applied = phase == 'applied'
        require(applied or code in REJECTED_CODES)
        require(run is not None)
        expected = {'transition_sequence': 1, 'outcome': phase, 'expected_revision': 0,
                    'applied_revision': 1 if applied else None,
                    'projected_job_status': 'QUEUED' if applied else 'DRAFT',
                    'projected_revision': 1 if applied else 0}
        receipt = value['receipt']
        require(type(receipt) is dict and receipt == expected and set(receipt) == set(expected))
        for key in ('transition_sequence', 'expected_revision', 'projected_revision'):
            require(type(receipt[key]) is int)
        require(receipt['applied_revision'] is None or type(receipt['applied_revision']) is int)
    else:
        require(value['receipt'] is None)
        if phase == 'quarantined':
            require(code in QUARANTINE_CODES)
        else:
            require(code is None)
            require((run is None) == (phase == 'pending'))
    return value
