"""Immutable owner deployment/build identity checked before claiming or polling."""
from dataclasses import dataclass

from .execution_protocol import PROTOCOL, WORKFLOW_TYPE, QUEUE_PREFIX, SHA, ProtocolError, digest


@dataclass(frozen=True)
class ExecutionIdentity:
    deployment_id: str
    namespace: str
    server_endpoint: str
    server_config_sha256: str
    build_id: str
    source_manifest_sha256: str
    environment_manifest_sha256: str

    @property
    def task_queue(self):
        return QUEUE_PREFIX + self.build_id

    def validate(self):
        for value in (self.server_config_sha256, self.build_id,
                      self.source_manifest_sha256, self.environment_manifest_sha256):
            if type(value) is not str or not SHA.fullmatch(value):
                raise ProtocolError('BUILD_UNAVAILABLE')
        deployment = {'protocol_version': PROTOCOL, 'deployment_id': self.deployment_id,
                      'namespace': self.namespace, 'server_endpoint': self.server_endpoint}
        build = {'protocol_version': PROTOCOL, 'source_manifest_sha256': self.source_manifest_sha256,
                 'environment_manifest_sha256': self.environment_manifest_sha256,
                 'workflow_type': WORKFLOW_TYPE}
        if (digest('ifpmic.b03.deployment.v1', deployment) != self.server_config_sha256
                or digest('ifpmic.b03.build.v1', build) != self.build_id):
            raise ProtocolError('BUILD_UNAVAILABLE')

    def check_build(self, build):
        expected = {'deployment_id': self.deployment_id, 'build_id': self.build_id,
                    'source_manifest_sha256': self.source_manifest_sha256,
                    'environment_manifest_sha256': self.environment_manifest_sha256,
                    'workflow_type': WORKFLOW_TYPE, 'task_queue': self.task_queue,
                    'protocol_version': PROTOCOL, 'enabled': True}
        if any(type(build.get(k)) is not type(v) or build[k] != v for k, v in expected.items()):
            raise ProtocolError('BUILD_UNAVAILABLE')

    def check_deployment(self, value):
        expected = {'deployment_id': self.deployment_id, 'namespace': self.namespace,
                    'server_endpoint': self.server_endpoint, 'server_config_sha256': self.server_config_sha256}
        if any(value.get(k) != v for k, v in expected.items()):
            raise ProtocolError('BINDING_CONFLICT')

    def check_dispatcher(self, value):
        self.validate()
        self.check_deployment(value)
        builds = value.get('builds')
        if type(builds) is not list:
            raise ProtocolError('BUILD_UNAVAILABLE')
        matches = [b for b in builds if b.get('build_id') == self.build_id]
        if len(matches) != 1:
            raise ProtocolError('BUILD_UNAVAILABLE')
        self.check_build(matches[0])

    def check_projector(self, value):
        self.validate()
        self.check_deployment(value)
        self.check_build(value)
