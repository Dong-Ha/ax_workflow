"""H2's small deterministic wire contract. No credentials or command bodies."""
import hashlib
import json
import re
from uuid import UUID

PROTOCOL = 'h2-v1'
WORKFLOW_TYPE = 'IFPMICJobWorkflow'
QUEUE_PREFIX = 'ifpmic.build.'
START_FIELDS = {'protocol_version', 'job_id', 'project_id', 'binding_sha256'}
SHA = re.compile(r'^[0-9a-f]{64}$')


class ProtocolError(Exception):
    def __init__(self, code='BINDING_CONFLICT'):
        self.code = code
        super().__init__(code)


def canonical_uuid(value):
    try:
        return type(value) is str and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def canonical(value):
    def validate(item):
        if item is None or type(item) in (str, int, bool):
            return
        if type(item) is list:
            for child in item:
                validate(child)
            return
        if type(item) is dict and all(type(k) is str for k in item):
            for child in item.values():
                validate(child)
            return
        raise ProtocolError()
    validate(value)
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('ascii')


def digest(domain, value):
    return hashlib.sha256(domain.encode('ascii') + b'\0' + canonical(value)).hexdigest()


def workflow_id(job_id):
    if not canonical_uuid(job_id):
        raise ProtocolError('COMMAND_IDENTITY_CONFLICT')
    return 'ifpmic.job.' + job_id


def build_from_queue(queue):
    if type(queue) is not str or not queue.startswith(QUEUE_PREFIX) or not SHA.fullmatch(queue[len(QUEUE_PREFIX):]):
        raise ProtocolError('BUILD_UNAVAILABLE')
    return queue[len(QUEUE_PREFIX):]


def start_input(binding):
    if type(binding) is not dict or not {'job_id', 'project_id', 'binding_sha256'} <= set(binding):
        raise ProtocolError()
    value = {k: binding[k] for k in ('job_id', 'project_id', 'binding_sha256')}
    value['protocol_version'] = PROTOCOL
    validate_start(value)
    return value


def validate_start(value):
    if (type(value) is not dict or set(value) != START_FIELDS or
            value['protocol_version'] != PROTOCOL or not canonical_uuid(value['job_id']) or
            type(value['binding_sha256']) is not str or not SHA.fullmatch(value['binding_sha256'])):
        raise ProtocolError()
    project = value['project_id']
    if type(project) is not str or not project or any(ord(c) < 32 or ord(c) == 127 for c in project):
        raise ProtocolError()
    try:
        project.encode('utf-8')
    except UnicodeError:
        raise ProtocolError() from None
    return value


def activation_proposal(job_id, run_id, build_id, binding_sha256, command_id, payload_sha256):
    if (not canonical_uuid(job_id) or not canonical_uuid(run_id) or not canonical_uuid(command_id)
            or any(type(x) is not str or not SHA.fullmatch(x)
                   for x in (build_id, binding_sha256, payload_sha256))):
        raise ProtocolError()
    return {'protocol_version': PROTOCOL, 'kind': 'activate_create', 'job_id': job_id,
            'run_id': run_id, 'build_id': build_id, 'binding_sha256': binding_sha256,
            'transition_sequence': 1, 'expected_revision': 0, 'command_id': command_id,
            'command_payload_sha256': payload_sha256}


def proposal_digest(proposal):
    fields = {'protocol_version', 'kind', 'job_id', 'run_id', 'build_id', 'binding_sha256',
              'transition_sequence', 'expected_revision', 'command_id', 'command_payload_sha256'}
    if type(proposal) is not dict or set(proposal) != fields:
        raise ProtocolError('PROPOSAL_COLLISION')
    expected = activation_proposal(*(proposal[k] for k in
        ('job_id', 'run_id', 'build_id', 'binding_sha256', 'command_id', 'command_payload_sha256')))
    if any(type(proposal[k]) is not type(v) or proposal[k] != v for k, v in expected.items()):
        raise ProtocolError('PROPOSAL_COLLISION')
    return digest('ifpmic.b03.transition.v1', expected)
