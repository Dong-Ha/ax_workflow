"""Create-once private workspaces; never adopt or delete unknown contents."""
from contextlib import contextmanager, ExitStack
import errno
import json
import os
import stat
from uuid import uuid4

from .request_contract import canonical_uuid

MARKER = '.ifpmic-workspace.json'
CHILDREN = ('source', 'tc', 'artifacts', 'build')
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class WorkspaceError(Exception):
    CODES = {'WORKSPACE_UNSAFE', 'WORKSPACE_NO_SPACE', 'WORKSPACE_IO'}

    def __init__(self, code):
        self.code = code if code in self.CODES else 'WORKSPACE_IO'
        super().__init__(self.code)


def identity(info):
    return info.st_dev, info.st_ino


def safe_info(info, kind, mode, device=None):
    if (not kind(info.st_mode) or info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) != mode or (device is not None and info.st_dev != device)):
        raise WorkspaceError('WORKSPACE_UNSAFE')


def io_error(error):
    if error.errno in (errno.ENOSPC, errno.EDQUOT):
        return WorkspaceError('WORKSPACE_NO_SPACE')
    if error.errno in (errno.ELOOP, errno.ENOTDIR):
        return WorkspaceError('WORKSPACE_UNSAFE')
    return WorkspaceError('WORKSPACE_IO')


class WorkspaceFilesystem:
    def __init__(self, root, *, fault_hook=None):
        self.root = root
        self.fault_hook = fault_hook

    def hook(self, name):
        if self.fault_hook:
            self.fault_hook(name)

    @contextmanager
    def open_root(self):
        with ExitStack() as stack:
            fd = os.open('/', DIR_FLAGS)
            stack.callback(os.close, fd)
            parts = self.root.split('/')[1:]
            if not parts or any(not part or part in ('.', '..') for part in parts):
                raise WorkspaceError('WORKSPACE_UNSAFE')
            for part in parts:
                ancestor = os.fstat(fd)
                mode = stat.S_IMODE(ancestor.st_mode)
                if (ancestor.st_uid not in (0, os.geteuid()) or
                        (mode & 0o022 and not (ancestor.st_uid == 0 and mode & stat.S_ISVTX))):
                    raise WorkspaceError('WORKSPACE_UNSAFE')
                fd = os.open(part, DIR_FLAGS, dir_fd=fd)
                stack.callback(os.close, fd)
            safe_info(os.fstat(fd), stat.S_ISDIR, 0o700)
            yield fd

    def check_root(self):
        try:
            with self.open_root():
                pass
        except OSError as error:
            raise io_error(error) from None

    @staticmethod
    def directory(parent, name, device, stack):
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        safe_info(before, stat.S_ISDIR, 0o700, device)
        fd = os.open(name, DIR_FLAGS, dir_fd=parent)
        stack.callback(os.close, fd)
        after = os.fstat(fd)
        safe_info(after, stat.S_ISDIR, 0o700, device)
        if identity(before) != identity(after):
            raise WorkspaceError('WORKSPACE_UNSAFE')
        return fd

    @staticmethod
    def marker(job, expected, device):
        try:
            before = os.stat(MARKER, dir_fd=job, follow_symlinks=False)
        except FileNotFoundError:
            return None
        # Reject devices/FIFOs before open, then protect a substitution race too.
        safe_info(before, stat.S_ISREG, 0o600, device)
        fd = os.open(MARKER, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=job)
        try:
            after = os.fstat(fd)
            safe_info(after, stat.S_ISREG, 0o600, device)
            if identity(before) != identity(after):
                raise WorkspaceError('WORKSPACE_UNSAFE')
            body = bytearray()
            while len(body) <= len(expected):
                chunk = os.read(fd, len(expected) + 1 - len(body))
                if not chunk:
                    break
                body.extend(chunk)
            current = os.stat(MARKER, dir_fd=job, follow_symlinks=False)
            safe_info(current, stat.S_ISREG, 0o600, device)
            if bytes(body) != expected or identity(current) != identity(after):
                raise WorkspaceError('WORKSPACE_UNSAFE')
            return identity(after)
        finally:
            os.close(fd)

    def publish(self, root, job, job_id, expected, device):
        name = f'.ifpmic-marker-{job_id}-{uuid4()}'
        fd = None
        created = None
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=root)
            created = os.fstat(fd)
            safe_info(created, stat.S_ISREG, 0o600, device)
            self.hook('workspace_before_marker_write')
            offset = 0
            while offset < len(expected):
                count = os.write(fd, expected[offset:])
                if count <= 0:
                    raise OSError(errno.EIO, 'marker write failed')
                offset += count
            self.hook('workspace_after_marker_write')
            self.hook('workspace_before_marker_fsync')
            os.fsync(fd)
            self.hook('workspace_after_marker_fsync')
            self.hook('workspace_before_marker_close')
            closing, fd = fd, None
            os.close(closing)
            self.hook('workspace_after_marker_close')
            current = os.stat(name, dir_fd=root, follow_symlinks=False)
            safe_info(current, stat.S_ISREG, 0o600, device)
            if identity(current) != identity(created):
                raise WorkspaceError('WORKSPACE_UNSAFE')
            self.hook('workspace_before_marker_publish')
            try:
                os.link(name, MARKER, src_dir_fd=root, dst_dir_fd=job, follow_symlinks=False)
            except FileExistsError:
                pass  # A matching marker-first winner is normal, never overwrite.
            self.hook('workspace_after_marker_publish')
            if self.marker(job, expected, device) is None:
                raise WorkspaceError('WORKSPACE_UNSAFE')
        finally:
            if fd is not None:
                os.close(fd)
            if created is not None:
                current = os.stat(name, dir_fd=root, follow_symlinks=False)
                safe_info(current, stat.S_ISREG, 0o600, device)
                if identity(current) != identity(created):
                    raise WorkspaceError('WORKSPACE_UNSAFE')
                os.unlink(name, dir_fd=root)

    def provision(self, job_id, workspace_token):
        if not canonical_uuid(job_id) or not canonical_uuid(workspace_token):
            raise WorkspaceError('WORKSPACE_UNSAFE')
        expected = (json.dumps({'format': 'ifpmic.workspace.v1', 'job_id': job_id,
                               'workspace_token': workspace_token}, sort_keys=True,
                              separators=(',', ':'), ensure_ascii=True) + '\n').encode('ascii')
        try:
            with self.open_root() as root, ExitStack() as stack:
                root_info = os.fstat(root)
                device = root_info.st_dev
                self.hook('workspace_before_mkdir')
                try:
                    os.mkdir(job_id, 0o700, dir_fd=root)
                except FileExistsError:
                    pass
                self.hook('workspace_after_mkdir')
                job = self.directory(root, job_id, device, stack)
                marker = self.marker(job, expected, device)
                if marker is None and os.listdir(job):
                    # Another valid reconciler may have published after lookup.
                    marker = self.marker(job, expected, device)
                    if marker is None:
                        raise WorkspaceError('WORKSPACE_UNSAFE')
                if marker is None:
                    self.publish(root, job, job_id, expected, device)
                existing = set(os.listdir(job))
                if not existing <= {MARKER, *CHILDREN}:
                    raise WorkspaceError('WORKSPACE_UNSAFE')
                # Inspect every preexisting child before adding missing layout.
                for name in CHILDREN:
                    if name in existing:
                        current = self.directory(job, name, device, stack)
                        if os.listdir(current):
                            raise WorkspaceError('WORKSPACE_UNSAFE')
                self.hook('workspace_before_children')
                children = {}
                for name in CHILDREN:
                    try:
                        os.mkdir(name, 0o700, dir_fd=job)
                    except FileExistsError:
                        pass
                    child = self.directory(job, name, device, stack)
                    if os.listdir(child):
                        raise WorkspaceError('WORKSPACE_UNSAFE')
                    children[name] = child
                self.hook('workspace_after_children')

                def validate():
                    with self.open_root() as current:
                        if identity(os.fstat(current)) != identity(root_info):
                            raise WorkspaceError('WORKSPACE_UNSAFE')
                    if identity(os.stat(job_id, dir_fd=root, follow_symlinks=False)) != identity(os.fstat(job)):
                        raise WorkspaceError('WORKSPACE_UNSAFE')
                    safe_info(os.stat(job_id, dir_fd=root, follow_symlinks=False), stat.S_ISDIR, 0o700, device)
                    if set(os.listdir(job)) != {MARKER, *CHILDREN}:
                        raise WorkspaceError('WORKSPACE_UNSAFE')
                    if self.marker(job, expected, device) is None:
                        raise WorkspaceError('WORKSPACE_UNSAFE')
                    for name, child in children.items():
                        current = os.stat(name, dir_fd=job, follow_symlinks=False)
                        safe_info(current, stat.S_ISDIR, 0o700, device)
                        if identity(current) != identity(os.fstat(child)) or os.listdir(child):
                            raise WorkspaceError('WORKSPACE_UNSAFE')

                validate()
                self.hook('workspace_before_children_sync')
                for child in children.values():
                    os.fsync(child)
                self.hook('workspace_after_children_sync')
                self.hook('workspace_before_directory_sync')
                os.fsync(job)
                self.hook('workspace_after_directory_sync')
                self.hook('workspace_before_parent_sync')
                os.fsync(root)
                self.hook('workspace_after_parent_sync')
                validate()
        except OSError as error:
            raise io_error(error) from None
