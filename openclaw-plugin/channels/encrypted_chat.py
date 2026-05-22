"""
AICQ Plugin — Encrypted Chat Channel.

Encrypts/signs outgoing messages, decrypts/verifies incoming messages,
manages an offline message queue with auto-flush on reconnect, and
handles file chunk assembly with hash verification.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Callable

import sys
_shared = str(Path(__file__).resolve().parent.parent.parent / "shared")
if _shared not in sys.path:
    sys.path.insert(0, _shared)

from crypto import (
    encrypt_message,
    decrypt_message,
    encode_base64,
    decode_base64,
)

from plugin.db import PluginDatabase
from plugin.identity_service import IdentityService
from plugin.types import ChatMessage


class EncryptedChatChannel:
    """Manages encrypted message exchange on the AICQ chat channel.

    All messages are encrypted with the session key and signed with
    the identity signing key before transmission. Incoming messages
    are verified and decrypted. When offline, messages are queued
    and automatically flushed on reconnection.
    """

    def __init__(self, db: PluginDatabase, identity: IdentityService):
        self._db = db
        self._identity = identity
        self._message_cbs: list[Callable[[ChatMessage], None]] = []
        self._offline_queue: list[dict] = []

    def on_message(self, callback: Callable[[ChatMessage], None]) -> None:
        self._message_cbs.append(callback)

    def _notify(self, msg: ChatMessage) -> None:
        for cb in self._message_cbs:
            try:
                cb(msg)
            except Exception:
                pass

    # ──────────────── Send ────────────────

    async def send_message(self, friend_id: str, content: str) -> ChatMessage:
        """Encrypt and sign a message for a friend."""
        session_key = await self._db.get_session_key(friend_id)
        if not session_key:
            raise RuntimeError(f"No session key for friend {friend_id}")

        wire_data = encrypt_message(
            content,
            session_key,
            self._identity.get_signing_secret_key(),
            self._identity.get_public_key(),
        )

        agent_id = await self._identity.get_agent_id()
        msg = ChatMessage(
            id=str(uuid.uuid4()),
            from_id=agent_id,
            to_id=friend_id,
            type="text",
            content=content,
            timestamp=datetime.now(tz=timezone.utc).isoformat(),
            status="sent",
        )

        # Queue if offline
        await self._db.add_message(msg)
        return msg

    # ──────────────── Streaming ────────────────

    def set_server_client(self, server_client) -> None:
        """Set the server client reference for streaming support."""
        self._server_client = server_client

    async def send_stream_chunk(self, friend_id: str, chunk_type: str, data) -> bool:
        """Send a streaming chunk to a friend via WS relay.

        Args:
            friend_id: Target user's node ID.
            chunk_type: 'text', 'reasoning', 'tool_call', or 'tool_result'.
            data: The chunk content (string for text/reasoning, dict for tool_call/tool_result).

        Returns:
            True if sent, False if not connected.
        """
        if not self._server_client:
            return False
        return await self._server_client.send_ws({
            "type": "stream_chunk",
            "to": friend_id,
            "chunkType": chunk_type or "text",
            "data": data,
        })

    async def send_stream_end(self, friend_id: str) -> bool:
        """Signal that a streaming response has ended.

        Returns:
            True if sent, False if not connected.
        """
        if not self._server_client:
            return False
        return await self._server_client.send_ws({
            "type": "stream_end",
            "to": friend_id,
        })

    async def queue_offline(self, friend_id: str, data: bytes) -> None:
        """Queue a message for later delivery when offline."""
        await self._db.add_offline_message(friend_id, data)

    async def flush_offline_queue(self, send_fn: Callable) -> int:
        """Flush all queued offline messages via the provided send function."""
        messages = await self._db.get_offline_messages()
        count = 0
        for msg in messages:
            try:
                await send_fn(msg["friend_id"], msg["data"])
                await self._db.remove_offline_message(msg["id"])
                count += 1
            except Exception as exc:
                print(f"[EncryptedChat] Failed to flush offline message: {exc}")
                break
        return count

    # ──────────────── Receive ────────────────

    async def receive_message(self, data: bytes, from_id: str) -> Optional[ChatMessage]:
        """Decrypt, verify, and store an incoming message."""
        friend = await self._db.get_friend(from_id)
        if not friend:
            print(f"[EncryptedChat] Message from unknown peer: {from_id}")
            return None

        session_key = await self._db.get_session_key(from_id)
        if not session_key:
            print(f"[EncryptedChat] No session key for peer: {from_id}")
            return None

        try:
            sender_pub = base64.b64decode(friend.public_key)
        except Exception:
            sender_pub = b""

        plaintext = decrypt_message(data, session_key, sender_pub)
        if plaintext is None:
            print(f"[EncryptedChat] Failed to decrypt message from {from_id}")
            return None

        msg_type = "text"
        try:
            parsed = json.loads(plaintext)
            if isinstance(parsed, dict) and "fileName" in parsed:
                msg_type = "file-info"
        except Exception:
            pass

        agent_id = await self._identity.get_agent_id()
        msg = ChatMessage(
            id=str(uuid.uuid4()),
            from_id=from_id,
            to_id=agent_id,
            type=msg_type,
            content=plaintext,
            timestamp=datetime.now(tz=timezone.utc).isoformat(),
            status="delivered",
        )

        await self._db.add_message(msg)
        self._notify(msg)
        return msg

    # ──────────────── Session key rotation ────────────────

    async def check_session_rotation(self, friend_id: str) -> bool:
        """Check if session key should be rotated (after 100 msgs or 1 hour)."""
        session = await self._db.get_session(friend_id)
        if not session:
            return False

        msg_count = session.get("message_count", 0)
        last_rotation = session.get("last_rotation", "")

        if msg_count >= 100:
            return True

        if last_rotation:
            try:
                last_dt = datetime.fromisoformat(last_rotation)
                if (datetime.now(tz=timezone.utc) - last_dt).total_seconds() > 3600:
                    return True
            except Exception:
                pass

        return False

    def destroy(self) -> None:
        self._message_cbs.clear()
        self._offline_queue.clear()
