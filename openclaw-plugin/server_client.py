"""
AICQ Plugin Server Client
==========================
REST + WebSocket client for communicating with the AICQ relay server.

Features:
- REST API client (aiohttp) for server endpoints
- WebSocket client with JWT auth via Ed25519 challenge-response
- Exponential backoff reconnection (1min aggressive -> hourly retry)
- Offline message queue with auto-flush on reconnect
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from typing import Any, Callable, Coroutine, Dict, List, Optional

import aiohttp

from .db import PluginDatabase, iso_now
from .identity_service import IdentityService
from .types import PluginConfig, PluginState

logger = logging.getLogger("aicq.plugin.server_client")

# ─── Backoff configuration ─────────────────────────────────────────────

_INITIAL_BACKOFF: float = 1.0       # seconds
_MAX_BACKOFF: float = 3600.0        # 1 hour
_BACKOFF_MULTIPLIER: float = 2.0
_AUTH_TIMEOUT: float = 30.0         # seconds to wait for WS auth
_PING_INTERVAL: float = 30.0        # seconds between pings


class ServerClient:
    """Client for the AICQ relay server.

    Manages REST API calls and WebSocket connection with automatic
    reconnection and offline message queuing.

    Parameters
    ----------
    config:
        Plugin configuration (contains server URL and agent ID).
    db:
        Plugin database for offline queue persistence.
    identity:
        Identity service for signing challenges.
    """

    def __init__(
        self,
        config: PluginConfig,
        db: PluginDatabase,
        identity: IdentityService,
    ) -> None:
        self.config = config
        self.db = db
        self.identity = identity

        # HTTP session (created on first use)
        self._http_session: Optional[aiohttp.ClientSession] = None

        # WebSocket state
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._ws_connected = asyncio.Event()
        self._state = PluginState.DISCONNECTED
        self._jwt_token: Optional[str] = None

        # Reconnection
        self._backoff = _INITIAL_BACKOFF
        self._reconnect_task: Optional[asyncio.Task] = None
        self._running = False

        # Message handling
        self._message_handlers: Dict[str, List[Callable]] = {}
        self._ws_task: Optional[asyncio.Task] = None

        # Offline queue (in-memory, backed by DB)
        self._offline_queue: deque[Dict[str, Any]] = deque(maxlen=1000)

    @property
    def state(self) -> PluginState:
        """Current connection state."""
        return self._state

    @property
    def is_connected(self) -> bool:
        """Whether the WebSocket is connected and authenticated."""
        return self._state == PluginState.CONNECTED

    # ── HTTP Session ────────────────────────────────────────────────────

    async def _get_http_session(self) -> aiohttp.ClientSession:
        """Get or create the HTTP client session."""
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession(
                base_url=self.config.server_url,
                timeout=aiohttp.ClientTimeout(total=30),
                headers={"Content-Type": "application/json"},
            )
        return self._http_session

    # ── REST API Methods ────────────────────────────────────────────────

    async def register(self, public_key: str, agent_name: str = "") -> Dict[str, Any]:
        """Register a new agent account on the server.

        Parameters
        ----------
        public_key:
            Ed25519 signing public key (base64).
        agent_name:
            Optional display name for the agent.

        Returns
        -------
        dict
            Server response with account ID and JWT tokens.
        """
        session = await self._get_http_session()
        payload = {
            "public_key": public_key,
            "agent_name": agent_name,
        }
        async with session.post("/api/v1/auth/register/ai", json=payload) as resp:
            try:
                data = await resp.json()
            except Exception:
                text = await resp.text()
                raise RuntimeError(f"Registration failed: non-JSON response (HTTP {resp.status}): {text[:200]}")
            if resp.status == 200 or resp.status == 201:
                # Accept both camelCase and snake_case token names
                self._jwt_token = data.get("accessToken") or data.get("access_token")
                logger.info("Agent registered on server")
                return data
            logger.error("Registration failed: %s", data)
            raise RuntimeError(f"Registration failed: {data.get('error') or data.get('message', 'Unknown error')}")

    async def authenticate(self, challenge: str) -> Dict[str, Any]:
        """Authenticate using Ed25519 challenge-response.

        Signs the server-provided challenge with the agent's private key.

        Parameters
        ----------
        challenge:
            Challenge string provided by the server.

        Returns
        -------
        dict
            Server response with JWT access and refresh tokens.
        """
        if not self.identity.is_initialized:
            raise RuntimeError("Identity not initialized")

        signature = self.identity.sign(challenge)
        session = await self._get_http_session()
        payload = {
            "public_key": self.identity.signing_public_key,
            "signature": signature,
            "challenge": challenge,
        }
        async with session.post("/api/v1/auth/login/agent", json=payload) as resp:
            try:
                data = await resp.json()
            except Exception:
                text = await resp.text()
                raise RuntimeError(f"Authentication failed: non-JSON response (HTTP {resp.status}): {text[:200]}")
            if resp.status == 200:
                self._jwt_token = data.get("accessToken") or data.get("access_token")
                logger.info("Authenticated with server")
                return data
            raise RuntimeError(f"Authentication failed: {data.get('error') or data.get('message', 'Unknown error')}")

    async def get_challenge(self) -> str:
        """Request an authentication challenge from the server.

        Returns
        -------
        str
            The challenge string to sign.
        """
        session = await self._get_http_session()
        payload = {"public_key": self.identity.signing_public_key}
        async with session.post("/api/v1/auth/challenge", json=payload) as resp:
            try:
                data = await resp.json()
            except Exception:
                text = await resp.text()
                logger.warning("Challenge request failed: non-JSON response (HTTP %d)", resp.status)
                return ""
            return data.get("challenge", "")

    async def send_message(self, target_id: str, encrypted_payload: str) -> bool:
        """Send an encrypted message via the server REST API.

        Falls back to queuing offline if the server is unreachable.

        Parameters
        ----------
        target_id:
            Recipient's agent/node ID.
        encrypted_payload:
            The encrypted message payload (base64).

        Returns
        -------
        bool
            True if the message was sent successfully.
        """
        if not self.is_connected:
            # Queue for later
            await self.db.enqueue_offline(target_id, encrypted_payload)
            logger.debug("Message queued for offline delivery to %s", target_id)
            return False

        try:
            session = await self._get_http_session()
            headers = {"Authorization": f"Bearer {self._jwt_token}"}
            payload = {
                "targetId": target_id,
                "payload": encrypted_payload,
            }
            async with session.post("/api/v1/chat/messages", json=payload, headers=headers) as resp:
                if resp.status == 200:
                    return True
                logger.warning("Send message failed: %d", resp.status)
                return False
        except aiohttp.ClientError as exc:
            logger.warning("Send message error: %s", exc)
            await self.db.enqueue_offline(target_id, encrypted_payload)
            return False

    async def receive_messages(self, since: Optional[str] = None) -> List[Dict[str, Any]]:
        """Fetch messages from the server since a given timestamp.

        Parameters
        ----------
        since:
            ISO-8601 timestamp; if None, fetches recent messages.

        Returns
        -------
        list
            List of message dicts.
        """
        session = await self._get_http_session()
        headers = {"Authorization": f"Bearer {self._jwt_token}"}
        params = {}
        if since:
            params["since"] = since

        async with session.get("/api/v1/chat/messages", params=params, headers=headers) as resp:
            if resp.status == 200:
                try:
                    data = await resp.json()
                except Exception:
                    return []
                return data.get("messages", [])
            return []

    async def request_temp_number(self) -> Dict[str, Any]:
        """Request a temporary number for handshake initiation.

        Returns
        -------
        dict
            Contains ``number`` and ``expires_at``.
        """
        session = await self._get_http_session()
        headers = {"Authorization": f"Bearer {self._jwt_token}"}
        async with session.post("/api/v1/temp-number/request", headers=headers) as resp:
            try:
                data = await resp.json()
            except Exception:
                text = await resp.text()
                raise RuntimeError(f"Temp number request failed: non-JSON response (HTTP {resp.status}): {text[:200]}")
            if resp.status == 200 or resp.status == 201:
                # Save locally — accept both camelCase and snake_case
                number = data.get("number") or data.get("temp_number", "")
                expires_at = data.get("expiresAt") or data.get("expires_at", "")
                if number and expires_at:
                    await self.db.save_temp_number(number, expires_at)
                return data
            raise RuntimeError(f"Temp number request failed: {data.get('error') or data.get('message', 'Unknown error')}")

    async def revoke_temp_number(self, number: str) -> bool:
        """Revoke a temporary number.

        Returns True if the revocation was successful.
        """
        session = await self._get_http_session()
        headers = {"Authorization": f"Bearer {self._jwt_token}"}
        async with session.delete(f"/api/v1/temp-number/{number}", headers=headers) as resp:
            return resp.status == 200

    # ── WebSocket ───────────────────────────────────────────────────────

    async def connect_ws(self) -> None:
        """Connect to the server WebSocket with JWT authentication.

        On successful connection, flushes the offline queue.
        """
        if not self.identity.is_initialized:
            raise RuntimeError("Identity not initialized")

        self._state = PluginState.CONNECTING
        logger.info("Connecting to WebSocket at %s", self.config.server_url)

        try:
            session = await self._get_http_session()
            ws_url = self.config.server_url.replace("https://", "wss://").replace("http://", "ws://")
            ws_url = f"{ws_url}/ws"

            self._ws = await session.ws_connect(
                ws_url,
                heartbeat=_PING_INTERVAL,
                max_msg_size=262144,
            )

            # Send authentication
            auth_msg = {
                "type": "online",
                "nodeId": self.identity.agent_id,
                "token": self._jwt_token or "",
            }
            await self._ws.send_json(auth_msg)

            # Wait for ack
            try:
                msg = await asyncio.wait_for(self._ws.__anext__(), timeout=_AUTH_TIMEOUT)
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data.get("type") == "online_ack":
                        self._state = PluginState.CONNECTED
                        self._backoff = _INITIAL_BACKOFF  # Reset backoff
                        self._ws_connected.set()
                        logger.info("WebSocket connected and authenticated")

                        # Flush offline queue
                        await self._flush_offline_queue()

                        # Start message loop
                        self._ws_task = asyncio.create_task(self._ws_message_loop())
                        return
                    elif data.get("type") == "error":
                        logger.error("WS auth failed: %s", data.get("message"))
                else:
                    logger.error("Unexpected WS message type during auth: %s", msg.type)
            except asyncio.TimeoutError:
                logger.error("WS authentication timeout")

            # Auth failed
            self._state = PluginState.ERROR
            if self._ws and not self._ws.closed:
                await self._ws.close()

        except aiohttp.ClientError as exc:
            logger.warning("WebSocket connection error: %s", exc)
            self._state = PluginState.ERROR

    async def _ws_message_loop(self) -> None:
        """Main WebSocket message processing loop."""
        if not self._ws:
            return

        try:
            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        await self._dispatch_ws_message(data)
                    except json.JSONDecodeError:
                        logger.warning("Invalid JSON in WS message")
                elif msg.type in (
                    aiohttp.WSMsgType.CLOSED,
                    aiohttp.WSMsgType.ERROR,
                ):
                    break
        except Exception:
            logger.exception("Error in WS message loop")
        finally:
            self._state = PluginState.DISCONNECTED
            self._ws_connected.clear()
            logger.info("WebSocket disconnected")

    async def _dispatch_ws_message(self, data: Dict[str, Any]) -> None:
        """Dispatch a WebSocket message to registered handlers."""
        msg_type = data.get("type", "")
        handlers = self._message_handlers.get(msg_type, [])
        for handler in handlers:
            try:
                await handler(data)
            except Exception:
                logger.exception("Error in WS message handler for type %s", msg_type)

        # Also call wildcard handlers
        wildcard_handlers = self._message_handlers.get("*", [])
        for handler in wildcard_handlers:
            try:
                await handler(data)
            except Exception:
                logger.exception("Error in wildcard WS handler")

    def on_message(self, msg_type: str, handler: Callable[[Dict[str, Any]], Coroutine]) -> None:
        """Register a handler for a specific WebSocket message type.

        Parameters
        ----------
        msg_type:
            The message type to handle, or ``"*"`` for all types.
        handler:
            Async callable that receives the message data dict.
        """
        if msg_type not in self._message_handlers:
            self._message_handlers[msg_type] = []
        self._message_handlers[msg_type].append(handler)

    async def send_ws(self, data: Dict[str, Any]) -> bool:
        """Send a message via WebSocket.

        Returns True if sent, False if not connected.
        """
        if not self._ws or self._ws.closed or not self.is_connected:
            return False
        try:
            await self._ws.send_json(data)
            return True
        except Exception as exc:
            logger.warning("WS send error: %s", exc)
            return False

    # ── Offline Queue ───────────────────────────────────────────────────

    async def _flush_offline_queue(self) -> None:
        """Send all queued offline messages."""
        friends = await self.db.list_friends()
        for friend in friends:
            friend_id = friend["id"]
            queued = await self.db.dequeue_offline(friend_id)
            for item in queued:
                try:
                    await self.send_message(friend_id, item["data"])
                    logger.debug("Flushed offline message to %s", friend_id)
                except Exception as exc:
                    logger.warning("Failed to flush offline message: %s", exc)
                    # Re-queue
                    await self.db.enqueue_offline(friend_id, item["data"])

    # ── Reconnection ────────────────────────────────────────────────────

    async def start_reconnection(self) -> None:
        """Start automatic reconnection with exponential backoff."""
        if self._running:
            return
        self._running = True
        self._reconnect_task = asyncio.create_task(self._reconnection_loop())

    async def stop_reconnection(self) -> None:
        """Stop the reconnection loop."""
        self._running = False
        if self._reconnect_task:
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass
            self._reconnect_task = None

    async def _reconnection_loop(self) -> None:
        """Periodically attempt to reconnect with exponential backoff."""
        while self._running:
            if self._state != PluginState.CONNECTED:
                try:
                    # Try to authenticate first if no token
                    if not self._jwt_token:
                        challenge = await self.get_challenge()
                        await self.authenticate(challenge)

                    # Connect WebSocket
                    await self.connect_ws()
                except Exception as exc:
                    logger.warning("Reconnection attempt failed: %s", exc)
                    self._state = PluginState.ERROR

            # Wait before next check
            if self._state == PluginState.CONNECTED:
                await asyncio.sleep(10)  # Check every 10s when connected
                self._backoff = _INITIAL_BACKOFF  # Reset
            else:
                logger.info("Next reconnection attempt in %.0fs", self._backoff)
                await asyncio.sleep(self._backoff)
                self._backoff = min(self._backoff * _BACKOFF_MULTIPLIER, _MAX_BACKOFF)

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the server client: authenticate, connect WS, start reconnection."""
        if not self.identity.is_initialized:
            raise RuntimeError("Identity not initialized; call identity.initialize() first")

        try:
            # Step 1: Get challenge and authenticate
            challenge = await self.get_challenge()
            await self.authenticate(challenge)

            # Step 2: Connect WebSocket
            await self.connect_ws()

            # Step 3: Start auto-reconnection
            await self.start_reconnection()

        except Exception as exc:
            logger.warning("Initial connection failed, will retry: %s", exc)
            self._state = PluginState.ERROR
            await self.start_reconnection()

    async def stop(self) -> None:
        """Gracefully disconnect and clean up."""
        await self.stop_reconnection()

        if self._ws and not self._ws.closed:
            # Send offline message
            try:
                await self._ws.send_json({"type": "offline"})
                await self._ws.close()
            except Exception:
                pass

        if self._ws_task:
            self._ws_task.cancel()
            try:
                await self._ws_task
            except asyncio.CancelledError:
                pass
            self._ws_task = None

        if self._http_session and not self._http_session.closed:
            await self._http_session.close()

        self._state = PluginState.DISCONNECTED
        logger.info("Server client stopped")
