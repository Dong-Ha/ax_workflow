"""Private bounded raw-TCP response-hold proxy for the accepted-start cut.

The barrier arms server-to-dispatcher holding only after the real dispatcher
reaches Dispatcher.hook('before_start_rpc'). Client-to-server bytes continue to
flow. The proxy records counts/events only; it never stores protocol payloads.
"""
from __future__ import annotations

import asyncio
import threading
import time
from typing import Optional


class TCPResponseHoldingProxy:
    def __init__(self, backend_host: str, backend_port: int, *, max_held_bytes: int = 1 << 20):
        if backend_host != "127.0.0.1" or not 1 <= backend_port <= 65535:
            raise ValueError("proxy backend must be the owned loopback Temporal endpoint")
        if type(max_held_bytes) is not int or max_held_bytes <= 0:
            raise ValueError("invalid proxy hold bound")
        self.backend_host = backend_host
        self.backend_port = backend_port
        self.max_held_bytes = max_held_bytes
        self.address: Optional[tuple[str, int]] = None
        self.request_forwarded = threading.Event()
        self.server_response_held = threading.Event()
        self.overflowed = threading.Event()
        self._started = threading.Event()
        self._closed = threading.Event()
        self._loop = None
        self._server = None
        self._thread = None
        self._startup_error = None
        self._armed = False
        self._release_event = None
        self._held = bytearray()
        self._held_lock = threading.Lock()
        self._held_count = 0
        self._response_condition = threading.Condition()
        self._response_sequence = 0
        self._connections = set()
        self._metrics_lock = threading.Lock()
        self._event_sequence = 0
        self._connection_sequence = 0
        self._connection_records = []
        self._events = []
        self._arm_monotonic = None
        self._client_to_server_bytes_after_arm = 0
        self._server_to_client_held_bytes_after_arm = 0
        self._server_to_client_forwarded_bytes_after_arm = 0
        self._server_to_client_bytes_total = 0
        self._event_limit = 4096
        self._event_overflow = False

    @property
    def held_response_bytes(self) -> int:
        with self._held_lock:
            return self._held_count

    @property
    def response_sequence(self) -> int:
        with self._response_condition:
            return self._response_sequence

    def _record_event(self, *, connection_id=None, direction, action, size=0,
                      after_arm=None):
        with self._metrics_lock:
            self._event_sequence += 1
            if len(self._events) < self._event_limit:
                self._events.append({
                    "sequence": self._event_sequence,
                    "monotonic": time.monotonic(),
                    "connection_id": connection_id,
                    "direction": direction,
                    "action": action,
                    "bytes": size,
                    "after_arm": self._armed if after_arm is None else after_arm,
                })
            else:
                self._event_overflow = True

    def snapshot(self) -> dict[str, object]:
        with self._metrics_lock:
            with self._held_lock:
                held_count = self._held_count
            return {
                "kind": "ifpmic.b03.h2.accepted-start.raw-tcp-proxy-observation.v1",
                "armed": self._armed,
                "arm_monotonic": self._arm_monotonic,
                "response_sequence": self.response_sequence,
                "request_forwarded_bytes_after_arm": self._client_to_server_bytes_after_arm,
                "server_response_bytes_held_after_arm": self._server_to_client_held_bytes_after_arm,
                "server_response_bytes_forwarded_after_arm": self._server_to_client_forwarded_bytes_after_arm,
                "server_response_bytes_total": self._server_to_client_bytes_total,
                "held_response_bytes": held_count,
                "overflowed": self.overflowed.is_set() or self._event_overflow,
                "http2_or_grpc_frames_decoded": False,
                "connection_records": list(self._connection_records),
                "events": list(self._events),
            }

    def wait_for_response_after(self, sequence: int, timeout: float) -> bool:
        with self._response_condition:
            return self._response_condition.wait_for(
                lambda: self._response_sequence > sequence, timeout=timeout)

    def start(self, timeout: float = 5.0) -> tuple[str, int]:
        if self._thread is not None:
            raise RuntimeError("proxy already started")
        self._thread = threading.Thread(target=self._run_loop, name="h2-start-loss-proxy", daemon=True)
        self._thread.start()
        if not self._started.wait(timeout):
            raise TimeoutError("proxy listener startup timed out")
        if self._startup_error is not None:
            raise RuntimeError("proxy listener startup failed") from self._startup_error
        assert self.address is not None
        return self.address

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        try:
            self._server = loop.run_until_complete(asyncio.start_server(self._accept, "127.0.0.1", 0))
            host, port = self._server.sockets[0].getsockname()[:2]
            self.address = (host, port)
            self._release_event = asyncio.Event()
            self._release_event.set()
        except BaseException as error:
            self._startup_error = error
            self._started.set()
            loop.close()
            return
        self._started.set()
        try:
            loop.run_forever()
        finally:
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()
            self._closed.set()

    async def _accept(self, client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
        try:
            backend_reader, backend_writer = await asyncio.wait_for(
                asyncio.open_connection(self.backend_host, self.backend_port), timeout=3.0)
        except Exception:
            client_writer.close()
            await client_writer.wait_closed()
            return
        with self._metrics_lock:
            self._connection_sequence += 1
            connection_id = self._connection_sequence
            client_peer = client_writer.get_extra_info("peername")
            client_local = client_writer.get_extra_info("sockname")
            backend_peer = backend_writer.get_extra_info("peername")
            backend_local = backend_writer.get_extra_info("sockname")
            self._connection_records.append({
                "connection_id": connection_id,
                "client_peer": list(client_peer) if isinstance(client_peer, tuple) else None,
                "client_local": list(client_local) if isinstance(client_local, tuple) else None,
                "backend_peer": list(backend_peer) if isinstance(backend_peer, tuple) else None,
                "backend_local": list(backend_local) if isinstance(backend_local, tuple) else None,
            })
        self._record_event(connection_id=connection_id, direction="connection",
                           action="opened", size=0)
        self._connections.add((client_writer, backend_writer))
        try:
            await asyncio.gather(
                self._pump(client_reader, backend_writer, client_to_server=True,
                           connection_id=connection_id),
                self._pump(backend_reader, client_writer, client_to_server=False,
                           connection_id=connection_id),
            )
        finally:
            self._connections.discard((client_writer, backend_writer))
            self._record_event(connection_id=connection_id, direction="connection",
                               action="closed", size=0)
            for writer in (client_writer, backend_writer):
                writer.close()
            for writer in (client_writer, backend_writer):
                try:
                    await writer.wait_closed()
                except Exception:
                    pass

    async def _pump(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                    *, client_to_server: bool, connection_id: int) -> None:
        while True:
            try:
                chunk = await reader.read(65536)
            except Exception:
                return
            if not chunk:
                try:
                    writer.write_eof()
                except (AttributeError, OSError, RuntimeError):
                    pass
                return
            if client_to_server:
                if self._armed:
                    self.request_forwarded.set()
                    with self._metrics_lock:
                        self._client_to_server_bytes_after_arm += len(chunk)
                try:
                    writer.write(chunk)
                    await writer.drain()
                except (ConnectionError, OSError):
                    return
                self._record_event(connection_id=connection_id, direction="client_to_server",
                                   action="forwarded", size=len(chunk))
                continue
            with self._metrics_lock:
                self._server_to_client_bytes_total += len(chunk)
            if self._armed:
                if len(self._held) + len(chunk) > self.max_held_bytes:
                    self.overflowed.set()
                    self._record_event(connection_id=connection_id, direction="server_to_client",
                                       action="hold_overflow", size=len(chunk))
                    return
                self._held.extend(chunk)
                with self._held_lock:
                    self._held_count += len(chunk)
                with self._metrics_lock:
                    self._server_to_client_held_bytes_after_arm += len(chunk)
                with self._response_condition:
                    self._response_sequence += 1
                    self._response_condition.notify_all()
                self._record_event(connection_id=connection_id, direction="server_to_client",
                                   action="held", size=len(chunk))
                self.server_response_held.set()
                continue
            if self._held:
                held = bytes(self._held)
                self._held.clear()
                try:
                    writer.write(held)
                    await writer.drain()
                except (ConnectionError, OSError):
                    return
            try:
                writer.write(chunk)
                await writer.drain()
            except (ConnectionError, OSError):
                return
            if self._arm_monotonic is not None:
                with self._metrics_lock:
                    self._server_to_client_forwarded_bytes_after_arm += len(chunk)
            self._record_event(connection_id=connection_id, direction="server_to_client",
                               action="forwarded", size=len(chunk))

    async def _arm(self) -> None:
        if self._armed:
            raise RuntimeError("response hold already armed")
        self._held.clear()
        with self._held_lock:
            self._held_count = 0
        self.request_forwarded.clear()
        self.server_response_held.clear()
        self.overflowed.clear()
        self._armed = True
        self._arm_monotonic = time.monotonic()
        self._record_event(connection_id=None, direction="control", action="armed", size=0,
                           after_arm=True)
        self._release_event.clear()

    def arm_after_barrier(self, timeout: float = 2.0) -> None:
        if self._loop is None or not self._loop.is_running():
            raise RuntimeError("proxy is not running")
        asyncio.run_coroutine_threadsafe(self._arm(), self._loop).result(timeout=timeout)

    def _call(self, coroutine, timeout: float = 5.0):
        if self._loop is None or not self._loop.is_running():
            raise RuntimeError("proxy is not running")
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result(timeout=timeout)

    async def _release(self) -> None:
        if self._armed:
            self._armed = False
            # The response was lost with the killed dispatcher. Never replay its
            # bytes into the restarted dispatcher’s new TCP connection.
            self._held.clear()
            self._record_event(connection_id=None, direction="control", action="released",
                               size=0, after_arm=True)
            self._release_event.set()

    def release(self) -> None:
        if self._loop is not None and self._loop.is_running():
            self._call(self._release())

    def close(self) -> None:
        if self._loop is None or self._thread is None:
            return
        if self._loop.is_running():
            async def shutdown():
                await self._release()
                if self._server is not None:
                    self._server.close()
                    await self._server.wait_closed()
                for client_writer, backend_writer in tuple(self._connections):
                    client_writer.close()
                    backend_writer.close()
            self._call(shutdown())
            self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5.0)
        if self._thread.is_alive():
            raise TimeoutError("proxy thread did not stop")

    def wait_for_request(self, timeout: float) -> bool:
        return self.request_forwarded.wait(timeout)

    def wait_for_held_response(self, timeout: float) -> bool:
        return self.server_response_held.wait(timeout)
