"""AICQ Plugin — P2P Connection Manager."""

from __future__ import annotations

import base64
from typing import Optional, Callable

from plugin.db import PluginDatabase


class SimpleP2PConnection:
    """Simple P2P connection using WebSocket relay for transport.

    Wraps relay sends to provide a P2P-like interface.
    """

    def __init__(self, peer_id: str, send_fn: Callable):
        self.peer_id = peer_id
        self._send_fn = send_fn
        self.connected = False
        self._data_cbs: list[Callable[[bytes], None]] = []

    def send(self, data: bytes) -> bool:
        if not self.connected:
            return False
        self._send_fn(self.peer_id, data)
        return True

    def on_data(self, callback: Callable[[bytes], None]) -> None:
        self._data_cbs.append(callback)

    def receive(self, data: bytes) -> None:
        for cb in self._data_cbs:
            try:
                cb(data)
            except Exception:
                pass


class P2PConnectionManager:
    """Manages P2P connections for the plugin via WebSocket relay."""

    def __init__(self, db: PluginDatabase):
        self._db = db
        self._connections: dict[str, SimpleP2PConnection] = {}
        self._send_fn: Optional[Callable] = None

    def set_send_function(self, fn: Callable) -> None:
        self._send_fn = fn

    async def connect(self, peer_id: str) -> SimpleP2PConnection:
        session_key = await self._db.get_session_key(peer_id)
        if not session_key:
            raise RuntimeError(f"No session key for {peer_id}")

        if peer_id in self._connections:
            return self._connections[peer_id]

        conn = SimpleP2PConnection(peer_id, self._send_fn or (lambda *a: None))
        conn.connected = True
        self._connections[peer_id] = conn
        return conn

    def disconnect(self, peer_id: str) -> None:
        conn = self._connections.pop(peer_id, None)
        if conn:
            conn.connected = False

    def is_connected(self, peer_id: str) -> bool:
        conn = self._connections.get(peer_id)
        return conn is not None and conn.connected

    def get_connection(self, peer_id: str) -> Optional[SimpleP2PConnection]:
        return self._connections.get(peer_id)

    def destroy(self) -> None:
        for conn in self._connections.values():
            conn.connected = False
        self._connections.clear()
