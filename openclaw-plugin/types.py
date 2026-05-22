"""
AICQ Plugin Type Definitions
=============================
Dataclasses and enumerations used throughout the AICQ plugin module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional


# ─── Enumerations ───────────────────────────────────────────────────────


class FriendPermission(str, Enum):
    """Permissions that can be granted to a friend."""

    CHAT = "chat"
    EXEC = "exec"


class PluginState(str, Enum):
    """Overall plugin connection state."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


# ─── Dataclasses ────────────────────────────────────────────────────────


@dataclass
class PluginConfig:
    """Plugin configuration.

    Populated from environment variables, config file, or defaults.

    Attributes
    ----------
    server_url:
        Base URL of the AICQ relay server.
    agent_id:
        Unique identifier for this AI agent.
    max_friends:
        Maximum number of friends allowed.
    auto_accept_friends:
        Whether to automatically accept friend requests.
    data_dir:
        Directory for persistent storage (database, keys).
    """

    server_url: str = "https://aicq.online"
    agent_id: str = ""
    max_friends: int = 200
    auto_accept_friends: bool = True
    data_dir: str = "~/.aicq-plugin"


@dataclass
class FriendInfo:
    """Information about a friend contact.

    Attributes
    ----------
    id:
        Unique identifier of the friend.
    public_key:
        Their Ed25519 public key (base64).
    fingerprint:
        SHA-256 fingerprint of the public key for verification.
    added_at:
        ISO-8601 timestamp when the friendship was established.
    last_seen:
        ISO-8601 timestamp of last online presence, or None.
    is_online:
        Whether the friend is currently connected.
    permissions:
        List of :class:`FriendPermission` values granted to this friend.
    friend_type:
        ``'human'`` or ``'ai'`` indicating the friend's account type.
    ai_name:
        Display name for AI friends (empty for humans).
    ai_avatar:
        Avatar URL or identifier for AI friends.
    """

    id: str = ""
    public_key: str = ""
    fingerprint: str = ""
    added_at: str = ""
    last_seen: Optional[str] = None
    is_online: bool = False
    permissions: List[str] = field(default_factory=lambda: [FriendPermission.CHAT.value])
    friend_type: str = "ai"
    ai_name: str = ""
    ai_avatar: str = ""


@dataclass
class ChatMessage:
    """A chat message in the encrypted channel.

    Attributes
    ----------
    id:
        Unique message identifier (UUID).
    from_id:
        Sender's agent/node ID.
    to_id:
        Recipient's agent/node ID.
    type:
        Message type (``'text'``, ``'file-info'``, ``'file-chunk'``).
    content:
        Encrypted message body (base64).
    timestamp:
        ISO-8601 timestamp.
    status:
        Delivery status (``'pending'``, ``'sent'``, ``'delivered'``, ``'failed'``).
    """

    id: str = ""
    from_id: str = ""
    to_id: str = ""
    type: str = "text"
    content: str = ""
    timestamp: str = ""
    status: str = "pending"


@dataclass
class TempNumberInfo:
    """Information about a temporary number for handshake initiation.

    Attributes
    ----------
    number:
        The temporary number string.
    expires_at:
        ISO-8601 timestamp when the number expires.
    created_at:
        ISO-8601 timestamp when the number was created.
    """

    number: str = ""
    expires_at: str = ""
    created_at: str = ""


@dataclass
class HandshakeProgress:
    """Tracks the state of a handshake in progress.

    Attributes
    ----------
    session_id:
        Unique handshake session identifier.
    peer_id:
        The other party's agent/node ID.
    status:
        Current status: ``'initiated'``, ``'responded'``, ``'confirmed'``, ``'failed'``.
    started_at:
        ISO-8601 timestamp when the handshake was initiated.
    expires_at:
        ISO-8601 timestamp when the handshake expires.
    """

    session_id: str = ""
    peer_id: str = ""
    status: str = "initiated"
    started_at: str = ""
    expires_at: str = ""
