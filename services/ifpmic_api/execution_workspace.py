"""Read-only use of G5's marker/inode validator; never repair or provision here."""
from contextlib import ExitStack
import errno
import json
import os
import stat

from .execution_protocol import canonical_uuid
from .workspace_fs import (CHILDREN, MARKER, WorkspaceError, WorkspaceFilesystem,
                           identity, io_error, safe_info)


class ReadyWorkspace(WorkspaceFilesystem):
    def validate_ready(self, job_id, workspace_token):
        if not canonical_uuid(job_id) or not canonical_uuid(workspace_token):
            raise WorkspaceError('WORKSPACE_UNSAFE')
        expected = (json.dumps({'format': 'ifpmic.workspace.v1', 'job_id': job_id,
                               'workspace_token': workspace_token}, sort_keys=True,
                              separators=(',', ':'), ensure_ascii=True) + '\n').encode('ascii')
        try:
            with self.open_root() as root, ExitStack() as stack:
                root_info = os.fstat(root)
                device = root_info.st_dev
                job = self.directory(root, job_id, device, stack)
                if set(os.listdir(job)) != {MARKER, *CHILDREN} or self.marker(job, expected, device) is None:
                    raise WorkspaceError('WORKSPACE_UNSAFE')
                children = {name: self.directory(job, name, device, stack) for name in CHILDREN}
                # H2 has no business step; its newly prepared workspace is empty.
                if any(os.listdir(fd) for fd in children.values()):
                    raise WorkspaceError('WORKSPACE_UNSAFE')
                with self.open_root() as current:
                    if identity(os.fstat(current)) != identity(root_info):
                        raise WorkspaceError('WORKSPACE_UNSAFE')
                current = os.stat(job_id, dir_fd=root, follow_symlinks=False)
                safe_info(current, stat.S_ISDIR, 0o700, device)
                if identity(current) != identity(os.fstat(job)) or self.marker(job, expected, device) is None:
                    raise WorkspaceError('WORKSPACE_UNSAFE')
                for name, fd in children.items():
                    current = os.stat(name, dir_fd=job, follow_symlinks=False)
                    safe_info(current, stat.S_ISDIR, 0o700, device)
                    if identity(current) != identity(os.fstat(fd)) or os.listdir(fd):
                        raise WorkspaceError('WORKSPACE_UNSAFE')
                if set(os.listdir(job)) != {MARKER, *CHILDREN}:
                    raise WorkspaceError('WORKSPACE_UNSAFE')
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                raise WorkspaceError('WORKSPACE_UNSAFE') from None
            raise io_error(error) from None
