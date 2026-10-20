"""One absolute deadline and controlled termination for the full H2 gate.

Pure stdlib; import only after the full runner's exact source/pre-gate checks.
Clock and command callbacks allow synthetic unit verification without services.
"""
from __future__ import annotations

import math
import os
from pathlib import Path
import select
import signal
import time


class GateBudgetError(RuntimeError):
    pass


class GateBudget:
    def __init__(self, deadline, *, recovery_reserve=15, command_recovery=7,
                 clock=None, sleep=None):
        if (type(deadline) not in (int, float) or not math.isfinite(deadline) or
                type(recovery_reserve) not in (int, float) or not math.isfinite(recovery_reserve) or
                type(command_recovery) not in (int, float) or not math.isfinite(command_recovery) or
                recovery_reserve <= 0 or command_recovery <= 0):
            raise GateBudgetError('INVALID_GATE_BUDGET')
        self.deadline = deadline
        self.work_deadline = deadline - recovery_reserve
        self.command_recovery = command_recovery
        self.clock = clock or time.monotonic
        self.sleep = sleep or time.sleep
        self.recovering = False
        self._handlers = None

    def require_work_time(self):
        if self.recovering or self.clock() >= self.work_deadline:
            raise GateBudgetError('GATE_WORK_DEADLINE_EXCEEDED')

    def command_timeout(self, requested):
        self.require_work_time()
        if type(requested) not in (int, float) or not math.isfinite(requested) or requested <= 0:
            raise GateBudgetError('INVALID_COMMAND_TIMEOUT')
        remaining = self.work_deadline - self.clock() - self.command_recovery
        if remaining <= 0:
            raise GateBudgetError('GATE_COMMAND_RECOVERY_RESERVE_EXHAUSTED')
        return min(requested, remaining)

    def run(self, runner, command, *, cwd, timeout, env):
        result = runner(command, cwd=cwd, timeout=self.command_timeout(timeout), env=env)
        self.require_work_time()
        return result

    def _request_stop(self, number, frame):
        # Repeated TERM/INT must not interrupt the same bounded cleanup epoch.
        if not self.recovering:
            self.recovering = True
            raise GateBudgetError('GATE_WORK_DEADLINE_EXCEEDED' if number == signal.SIGALRM
                                  else 'GATE_TERMINATION_REQUESTED')

    def arm(self):
        self.require_work_time()
        if self._handlers is not None or signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
            raise GateBudgetError('EXISTING_GATE_ALARM')
        signals = (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)
        self._handlers = {number: signal.getsignal(number) for number in signals}
        try:
            for number in signals:
                signal.signal(number, self._request_stop)
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, self.work_deadline - self.clock()))
        except BaseException:
            self.restore()
            raise

    def begin_recovery(self):
        self.recovering = True
        if self._handlers is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)

    def restore(self):
        if self._handlers is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            saved, self._handlers = self._handlers, None
            for number, handler in saved.items():
                signal.signal(number, handler)

    def finished_in_time(self):
        return self.clock() < self.deadline

    def cleanup(self, owned_children, reap_orphans):
        """Recover only current owned PID/ticks, never signal/wait after deadline."""
        self.begin_recovery()
        signalled = set()
        began = self.clock()
        # One cumulative recovery epoch:3s interrupt,2s terminate,5s kill.
        for number, offset in ((signal.SIGINT, 3), (signal.SIGTERM, 5), (signal.SIGKILL, 10)):
            if self.clock() >= self.deadline:
                break
            for pid, (_, state, started) in owned_children().items():
                if self.clock() >= self.deadline:
                    break
                if state == 'Z':
                    continue
                descriptor = None
                try:
                    descriptor = os.pidfd_open(pid)
                    current = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
                    if (self.clock() < self.deadline and current[19] == started and
                            not select.select([descriptor], [], [], 0)[0]):
                        signal.pidfd_send_signal(descriptor, number)
                        signalled.add(pid)
                except (ProcessLookupError, FileNotFoundError):
                    pass
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
            stage_deadline = min(self.deadline, began + offset)
            while self.clock() < stage_deadline:
                reap_orphans()
                if not owned_children():
                    return {'result': 'stopped', 'signalled_count': len(signalled), 'pid_alive': False}
                remaining = stage_deadline - self.clock()
                if remaining > 0:
                    self.sleep(min(0.05, remaining))
        # A read-only final observation does not create a new cleanup budget.
        remaining_children = owned_children()
        return {'result': 'unconfirmed' if remaining_children else 'stopped',
                'signalled_count': len(signalled), 'pid_alive': bool(remaining_children),
                'outer_deadline_exhausted': not self.finished_in_time()}
