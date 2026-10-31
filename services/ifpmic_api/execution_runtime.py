"""Explicit local dispatcher/worker entry point; configuration is private.

Run with -B and a fresh private -X pycache_prefix directory. This module never
starts a server, enrolls a principal, registers a build or installs dependencies.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
import signal
import sys
import threading

from .execution_manifest import load_config


async def run(config, identity):
    # Defer SDK worker imports until source/environment validation has succeeded.
    from temporalio.worker import Worker

    from .execution_activities import ActivationActivities
    from .execution_dispatcher import Dispatcher
    from .execution_store import ExecutionStore
    from .execution_temporal import TemporalTransport
    from .execution_workflow import IFPMICJobWorkflow
    from .execution_workspace import ReadyWorkspace

    store = ExecutionStore(dsn=config['dsn'])
    workspace = ReadyWorkspace(config['workspace_root'])
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    forced_exit = None

    def request_stop():
        nonlocal forced_exit
        if stopping.is_set():
            return
        stopping.set()
        # This process owns only itself. Bound termination even if a driver
        # thread cannot be cancelled; PG rolls its open transaction back.
        forced_exit = threading.Timer(15, lambda: os._exit(3))
        forced_exit.daemon = True
        forced_exit.start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, request_stop)
    executor = None
    tasks = []
    worker = None
    try:
        # Authenticated registry validation precedes ANY Temporal connection or
        # delivery claim. A private config cannot enroll or choose a fallback.
        if config['mode'] == 'dispatcher':
            identity.check_dispatcher(await asyncio.to_thread(store.call, 'read_dispatch_config'))
        else:
            identity.check_projector(await asyncio.to_thread(store.call, 'read_registered_build', identity.build_id))
        workspace.check_root()
        if stopping.is_set():
            return
        transport = await TemporalTransport.connect(identity)
        if stopping.is_set():
            return
        if config['mode'] == 'worker':
            executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='ifpmic-h2-activity')
            mock_mode = config.get('mock_task_mode')
            activities = ActivationActivities(store, identity, workspace, mock_task_mode=mock_mode)
            registered = [activities.read_activation, activities.project_activation]
            if mock_mode is not None:
                from .execution_mock_task import MockTaskActivities
                registered.append(MockTaskActivities(store, identity, workspace, mode=mock_mode).run)
            worker = Worker(transport.client, task_queue=identity.task_queue,
                workflows=[IFPMICJobWorkflow],
                activities=registered,
                activity_executor=executor, max_concurrent_activities=4,
                max_concurrent_workflow_tasks=4, build_id=identity.build_id,
                identity='ifpmic-h2', use_worker_versioning=False)
            tasks.append(asyncio.create_task(worker.run()))
        else:
            dispatcher = Dispatcher(store, transport, identity, workspace)

            async def pump():
                while not stopping.is_set():
                    result = await dispatcher.once()
                    # SQL applies delivery backoff; idle/startup failures also
                    # need bounded polling rather than a busy retry loop.
                    delay = 0.05 if result['status'] in ('dispatched', 'quarantined') else 1
                    try:
                        await asyncio.wait_for(stopping.wait(), delay)
                    except TimeoutError:
                        pass

            tasks.extend(asyncio.create_task(pump()) for _ in range(4))
        stop_task = asyncio.create_task(stopping.wait())
        tasks.append(stop_task)
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if task is not stop_task:
                # A requested stop may complete pumps alongside stop_task.
                # Still surface their actual failures before accepting normal
                # shutdown; an unsolicited successful return is also failure.
                task.result()
                if not stopping.is_set():
                    raise RuntimeError('DEPENDENCY_UNAVAILABLE')
    finally:
        # Fatal poller/worker failures need the same bound as a requested stop;
        # cancelling a to_thread await does not stop its underlying DB call.
        request_stop()
        if worker is not None:
            try:
                await asyncio.wait_for(worker.shutdown(), 10)
            except Exception:
                request_stop()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)
        # Keep the self-exit deadline armed on requested shutdown: Python may
        # still be waiting for an uncancellable thread at interpreter exit.


def main():
    # SDK exception logging can contain paths or error text. Operational output
    # from this launcher is a fixed code; private harnesses retain other evidence.
    sdk_logger = logging.getLogger('temporalio')
    sdk_logger.handlers = [logging.NullHandler()]
    sdk_logger.propagate = False
    try:
        if len(sys.argv) != 1 or not os.environ.get('IFPMIC_EXECUTION_CONFIG'):
            raise ValueError('BUILD_UNAVAILABLE')
        config, identity = load_config(os.environ['IFPMIC_EXECUTION_CONFIG'])
        asyncio.run(run(config, identity))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'DEPENDENCY_UNAVAILABLE'}}, separators=(',', ':')))
        return 3


if __name__ == '__main__':
    sys.exit(main())
