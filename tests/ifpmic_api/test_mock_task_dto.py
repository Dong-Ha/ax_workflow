import copy

import pytest

from services.ifpmic_api.errors import ApiError
from services.ifpmic_api.mock_task import CHECKS, SCHEMA_VERSION, TASK_KIND, validate_mock_task

JOB = '123e4567-e89b-42d3-a456-426614174000'
COMMAND = '223e4567-e89b-42d3-a456-426614174000'
RUN = '323e4567-e89b-42d3-a456-426614174000'
EXPECTED = {'job_id': JOB, 'command_id': COMMAND}


def pending():
    return {'schema_version': SCHEMA_VERSION, 'job_id': JOB, 'command_id': COMMAND,
            'admitted_run_id': None, 'status': 'pending', 'result': None, 'completed_at': None}


def completed():
    return {'schema_version': SCHEMA_VERSION, 'job_id': JOB, 'command_id': COMMAND,
            'admitted_run_id': RUN, 'status': 'completed',
            'result': {'task_kind': TASK_KIND, 'mode': 'mock', 'outcome': 'passed',
                       'checks': [{'name': name, 'status': 'passed'} for name in CHECKS],
                       'result_sha256': 'a' * 64},
            'completed_at': '2026-10-27T12:13:14.123456Z'}


def test_pending_and_completed_dtos_validate():
    assert validate_mock_task(pending(), EXPECTED)['status'] == 'pending'
    assert validate_mock_task(completed(), EXPECTED)['status'] == 'completed'


def test_completed_expected_run_is_checked_when_supplied():
    assert validate_mock_task(completed(), {**EXPECTED, 'admitted_run_id': RUN})['status'] == 'completed'
    with pytest.raises(ApiError) as raised:
        validate_mock_task(completed(), {**EXPECTED, 'admitted_run_id': COMMAND})
    assert raised.value.code == 'DEPENDENCY_UNAVAILABLE'


@pytest.mark.parametrize('mutate', [
    lambda dto: dto.update(extra='private'),
    lambda dto: dto.update(command_id=RUN),
    lambda dto: dto.update(job_id='not-a-uuid'),
    lambda dto: dto.update(admitted_run_id=None),
    lambda dto: dto.update(status='running'),
    lambda dto: dto.update(result={'private': 'payload'}),
    lambda dto: dto.update(completed_at='2026-02-30T12:00:00Z'),
    lambda dto: dto.update(completed_at='2026-10-27T12:00:00+00:00'),
])
def test_completed_malformed_or_private_dto_fails_closed(mutate):
    dto = copy.deepcopy(completed())
    mutate(dto)
    with pytest.raises(ApiError) as raised:
        validate_mock_task(dto, EXPECTED)
    assert raised.value.code == 'DEPENDENCY_UNAVAILABLE'


@pytest.mark.parametrize('mutate', [
    lambda dto: dto.update(extra='private'),
    lambda dto: dto.update(result={}),
    lambda dto: dto.update(admitted_run_id=RUN),
    lambda dto: dto.update(completed_at='2026-10-27T12:00:00Z'),
])
def test_pending_malformed_dto_fails_closed(mutate):
    dto = pending()
    mutate(dto)
    with pytest.raises(ApiError) as raised:
        validate_mock_task(dto, EXPECTED)
    assert raised.value.code == 'DEPENDENCY_UNAVAILABLE'


@pytest.mark.parametrize('bad_result', [
    {'task_kind': TASK_KIND, 'mode': 'mock', 'outcome': 'passed', 'checks': [], 'result_sha256': 'g' * 64},
    {'task_kind': TASK_KIND, 'mode': 'real', 'outcome': 'passed',
     'checks': [{'name': name, 'status': 'passed'} for name in CHECKS], 'result_sha256': 'a' * 64},
    {'task_kind': TASK_KIND, 'mode': 'mock', 'outcome': 'passed',
     'checks': [{'name': CHECKS[1], 'status': 'passed'}, {'name': CHECKS[0], 'status': 'passed'},
                {'name': CHECKS[2], 'status': 'passed'}], 'result_sha256': 'a' * 64},
])
def test_nested_result_shape_is_exact(bad_result):
    dto = completed()
    dto['result'] = bad_result
    with pytest.raises(ApiError) as raised:
        validate_mock_task(dto, EXPECTED)
    assert raised.value.code == 'DEPENDENCY_UNAVAILABLE'
