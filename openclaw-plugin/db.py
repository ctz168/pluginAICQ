"""
AICQ Plugin Database
=====================
Async SQLite database manager for the AICQ plugin.

Provides persistent storage for identity keys, friends, sessions,
chat history, temp numbers, pending requests, and offline message queue.
All operations are async via ``aiosqlite``.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import aiosqlite

logger = logging.getLogger("aicq.plugin.db")

# ─── JSON Helpers ───────────────────────────────────────────────────────


def json_serialize(value: Any) -> str:
    """Serialize a Python object to JSON for SQLite storage."""
    if value is None:
        return "[]"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_deserialize(value: Optional[str], default: Any = None) -> Any:
    """Deserialize a JSON string from SQLite."""
    if value is None:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def json_list(value: Optional[str]) -> List[str]:
    """Deserialize a JSON TEXT column into a list of strings."""
    result = json_deserialize(value, default=[])
    return result if isinstance(result, list) else []


def iso_now() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


# ─── Schema DDL ─────────────────────────────────────────────────────────

_SCHEMA_SQL = """
-- ═══════════════════════════════════════════════════════════════════════
--  identity
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS identity (
    agent_id              TEXT PRIMARY KEY,
    signing_public_key    TEXT NOT NULL,
    signing_secret_key    TEXT NOT NULL,
    exchange_public_key   TEXT NOT NULL,
    exchange_secret_key   TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT
);

-- ═══════════════════════════════════════════════════════════════════════
--  friends
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS friends (
    id            TEXT PRIMARY KEY,
    public_key    TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    added_at      TEXT NOT NULL,
    last_seen     TEXT,
    is_online     INTEGER NOT NULL DEFAULT 0,
    permissions   TEXT NOT NULL DEFAULT '["chat"]',
    friend_type   TEXT NOT NULL DEFAULT 'ai',
    ai_name       TEXT NOT NULL DEFAULT '',
    ai_avatar     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_friends_fingerprint ON friends(fingerprint);
CREATE INDEX IF NOT EXISTS idx_friends_online      ON friends(is_online);

-- ═══════════════════════════════════════════════════════════════════════
--  sessions
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sessions (
    peer_id          TEXT PRIMARY KEY,
    session_key      TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    message_count    INTEGER NOT NULL DEFAULT 0,
    last_rotation    TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════
--  chat_history
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_history (
    id          TEXT PRIMARY KEY,
    friend_id   TEXT NOT NULL,
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'text',
    content     TEXT NOT NULL DEFAULT '',
    timestamp   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_chat_history_friend_id  ON chat_history(friend_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_timestamp  ON chat_history(friend_id, timestamp);

-- ═══════════════════════════════════════════════════════════════════════
--  temp_numbers
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS temp_numbers (
    number      TEXT PRIMARY KEY,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_temp_numbers_expires ON temp_numbers(expires_at);

-- ═══════════════════════════════════════════════════════════════════════
--  pending_requests
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pending_requests (
    session_id            TEXT PRIMARY KEY,
    requester_id          TEXT NOT NULL,
    requester_public_key  TEXT NOT NULL,
    timestamp             TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════
--  offline_queue
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS offline_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    friend_id   TEXT NOT NULL,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offline_queue_friend ON offline_queue(friend_id);
"""


# ─── PluginDatabase ─────────────────────────────────────────────────────


class PluginDatabase:
    """Asynchronous SQLite database manager for the AICQ plugin.

    Usage::

        db = PluginDatabase(Path("~/.aicq-plugin/plugin.db").expanduser())
        await db.connect()
        # ... use db methods ...
        await db.close()
    """

    def __init__(self, db_path: Path) -> None:
        self.db_path = str(db_path)
        self._conn: Optional[aiosqlite.Connection] = None

    # ── Connection lifecycle ────────────────────────────────────────────

    async def connect(self) -> None:
        """Open the async SQLite connection and create schema."""
        if self._conn is not None:
            return

        # Ensure parent directory exists
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row

        # Performance & integrity pragmas
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.execute("PRAGMA busy_timeout=5000")

        # Create schema
        await self._conn.executescript(_SCHEMA_SQL)
        logger.info("Plugin database connected: %s", self.db_path)

    async def close(self) -> None:
        """Close the connection if open."""
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
            logger.info("Plugin database closed")

    @property
    def conn(self) -> aiosqlite.Connection:
        """Return the active connection or raise RuntimeError."""
        if self._conn is None:
            raise RuntimeError("Database connection is not open. Call connect() first.")
        return self._conn

    # ── Query helpers ───────────────────────────────────────────────────

    async def execute(self, query: str, params: Optional[Sequence[Any]] = None) -> aiosqlite.Cursor:
        """Execute a single SQL statement and return the cursor."""
        cursor = await self.conn.execute(query, params)
        await self.conn.commit()
        return cursor

    async def fetchone(self, query: str, params: Optional[Sequence[Any]] = None) -> Optional[Dict[str, Any]]:
        """Execute query and return the first row as a dict, or None."""
        cursor = await self.conn.execute(query, params)
        row = await cursor.fetchone()
        if row is None:
            return None
        return dict(row)

    async def fetchall(self, query: str, params: Optional[Sequence[Any]] = None) -> List[Dict[str, Any]]:
        """Execute query and return all rows as a list of dicts."""
        cursor = await self.conn.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    # ── Identity operations ─────────────────────────────────────────────

    async def save_identity(
        self,
        agent_id: str,
        signing_public_key: str,
        signing_secret_key: str,
        exchange_public_key: str,
        exchange_secret_key: str,
    ) -> None:
        """Save or replace the agent's identity keys."""
        now = iso_now()
        await self.execute(
            """
            INSERT OR REPLACE INTO identity
                (agent_id, signing_public_key, signing_secret_key,
                 exchange_public_key, exchange_secret_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (agent_id, signing_public_key, signing_secret_key,
             exchange_public_key, exchange_secret_key, now, now),
        )
        logger.info("Identity saved for agent %s", agent_id)

    async def load_identity(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Load identity keys for the given agent.

        Returns a dict with key fields, or None if not found.
        """
        return await self.fetchone("SELECT * FROM identity WHERE agent_id = ?", (agent_id,))

    # ── Friend operations ───────────────────────────────────────────────

    async def add_friend(
        self,
        friend_id: str,
        public_key: str,
        fingerprint: str,
        friend_type: str = "ai",
        ai_name: str = "",
        ai_avatar: str = "",
        permissions: Optional[List[str]] = None,
    ) -> None:
        """Add a friend to the local database."""
        now = iso_now()
        perms = json_serialize(permissions or ["chat"])
        await self.execute(
            """
            INSERT OR REPLACE INTO friends
                (id, public_key, fingerprint, added_at, last_seen,
                 is_online, permissions, friend_type, ai_name, ai_avatar)
            VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)
            """,
            (friend_id, public_key, fingerprint, now, perms, friend_type, ai_name, ai_avatar),
        )
        logger.info("Friend added: %s", friend_id)

    async def remove_friend(self, friend_id: str) -> bool:
        """Remove a friend. Returns True if a row was deleted."""
        cursor = await self.execute("DELETE FROM friends WHERE id = ?", (friend_id,))
        return cursor.rowcount > 0

    async def get_friend(self, friend_id: str) -> Optional[Dict[str, Any]]:
        """Get a single friend by ID."""
        return await self.fetchone("SELECT * FROM friends WHERE id = ?", (friend_id,))

    async def list_friends(self) -> List[Dict[str, Any]]:
        """List all friends."""
        return await self.fetchall("SELECT * FROM friends ORDER BY added_at DESC")

    async def update_friend_online(self, friend_id: str, is_online: bool) -> None:
        """Update a friend's online status and last_seen timestamp."""
        now = iso_now() if is_online else None
        await self.execute(
            "UPDATE friends SET is_online = ?, last_seen = COALESCE(?, last_seen) WHERE id = ?",
            (int(is_online), now, friend_id),
        )

    async def set_friend_permissions(self, friend_id: str, permissions: List[str]) -> None:
        """Update permissions for a friend."""
        perms = json_serialize(permissions)
        await self.execute(
            "UPDATE friends SET permissions = ? WHERE id = ?",
            (perms, friend_id),
        )

    # ── Session operations ──────────────────────────────────────────────

    async def save_session(self, peer_id: str, session_key: str) -> None:
        """Save or replace a session key for a peer."""
        now = iso_now()
        await self.execute(
            """
            INSERT OR REPLACE INTO sessions (peer_id, session_key, created_at, message_count, last_rotation)
            VALUES (?, ?, ?, 0, ?)
            """,
            (peer_id, session_key, now, now),
        )

    async def load_session(self, peer_id: str) -> Optional[Dict[str, Any]]:
        """Load session data for a peer."""
        return await self.fetchone("SELECT * FROM sessions WHERE peer_id = ?", (peer_id,))

    async def increment_session_message_count(self, peer_id: str) -> int:
        """Increment message count and return the new count."""
        await self.execute(
            "UPDATE sessions SET message_count = message_count + 1 WHERE peer_id = ?",
            (peer_id,),
        )
        row = await self.load_session(peer_id)
        return row["message_count"] if row else 0

    async def rotate_session_key(self, peer_id: str, new_key: str) -> None:
        """Rotate the session key for a peer."""
        now = iso_now()
        await self.execute(
            "UPDATE sessions SET session_key = ?, message_count = 0, last_rotation = ? WHERE peer_id = ?",
            (new_key, now, peer_id),
        )

    # ── Chat history operations ─────────────────────────────────────────

    async def save_message(
        self,
        friend_id: str,
        from_id: str,
        to_id: str,
        msg_type: str,
        content: str,
        status: str = "pending",
    ) -> str:
        """Save a chat message and return its ID."""
        msg_id = uuid.uuid4().hex
        now = iso_now()
        await self.execute(
            """
            INSERT INTO chat_history (id, friend_id, from_id, to_id, type, content, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (msg_id, friend_id, from_id, to_id, msg_type, content, now, status),
        )
        return msg_id

    async def get_chat_history(
        self, friend_id: str, limit: int = 100, before: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Get chat history with a friend, ordered by timestamp."""
        if before:
            return await self.fetchall(
                "SELECT * FROM chat_history WHERE friend_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?",
                (friend_id, before, limit),
            )
        return await self.fetchall(
            "SELECT * FROM chat_history WHERE friend_id = ? ORDER BY timestamp DESC LIMIT ?",
            (friend_id, limit),
        )

    async def update_message_status(self, msg_id: str, status: str) -> None:
        """Update the delivery status of a message."""
        await self.execute(
            "UPDATE chat_history SET status = ? WHERE id = ?",
            (status, msg_id),
        )

    # ── Temp number operations ──────────────────────────────────────────

    async def save_temp_number(self, number: str, expires_at: str) -> None:
        """Save a temp number."""
        now = iso_now()
        await self.execute(
            "INSERT OR REPLACE INTO temp_numbers (number, expires_at, created_at) VALUES (?, ?, ?)",
            (number, expires_at, now),
        )

    async def get_temp_number(self, number: str) -> Optional[Dict[str, Any]]:
        """Get a temp number entry."""
        return await self.fetchone("SELECT * FROM temp_numbers WHERE number = ?", (number,))

    async def cleanup_expired_temp_numbers(self) -> int:
        """Delete expired temp numbers. Returns count deleted."""
        now = iso_now()
        cursor = await self.execute("DELETE FROM temp_numbers WHERE expires_at < ?", (now,))
        return cursor.rowcount

    # ── Pending request operations ──────────────────────────────────────

    async def save_pending_request(
        self, session_id: str, requester_id: str, requester_public_key: str
    ) -> None:
        """Save a pending handshake request."""
        now = iso_now()
        await self.execute(
            """
            INSERT OR REPLACE INTO pending_requests
                (session_id, requester_id, requester_public_key, timestamp)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, requester_id, requester_public_key, now),
        )

    async def get_pending_requests(self) -> List[Dict[str, Any]]:
        """List all pending handshake requests."""
        return await self.fetchall("SELECT * FROM pending_requests ORDER BY timestamp DESC")

    async def remove_pending_request(self, session_id: str) -> None:
        """Remove a pending request after acceptance/rejection."""
        await self.execute("DELETE FROM pending_requests WHERE session_id = ?", (session_id,))

    # ── Offline queue operations ────────────────────────────────────────

    async def enqueue_offline(self, friend_id: str, data: str) -> int:
        """Queue a message for later delivery when the friend is offline.

        Returns the auto-generated row ID.
        """
        now = iso_now()
        cursor = await self.execute(
            "INSERT INTO offline_queue (friend_id, data, created_at) VALUES (?, ?, ?)",
            (friend_id, data, now),
        )
        return cursor.lastrowid  # type: ignore[return-value]

    async def dequeue_offline(self, friend_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        """Get and remove queued messages for a friend.

        Returns the messages and deletes them from the queue.
        """
        rows = await self.fetchall(
            "SELECT * FROM offline_queue WHERE friend_id = ? ORDER BY created_at ASC LIMIT ?",
            (friend_id, limit),
        )
        if rows:
            ids = [r["id"] for r in rows]
            placeholders = ",".join("?" * len(ids))
            await self.execute(
                f"DELETE FROM offline_queue WHERE id IN ({placeholders})",
                ids,
            )
        return rows

    async def get_offline_queue_size(self, friend_id: Optional[str] = None) -> int:
        """Get the number of queued messages, optionally filtered by friend."""
        if friend_id:
            row = await self.fetchone(
                "SELECT COUNT(*) as cnt FROM offline_queue WHERE friend_id = ?",
                (friend_id,),
            )
        else:
            row = await self.fetchone("SELECT COUNT(*) as cnt FROM offline_queue")
        return row["cnt"] if row else 0

    # ── General cleanup ─────────────────────────────────────────────────

    async def cleanup(self) -> Dict[str, int]:
        """Remove expired/stale data from all tables.

        Returns a dict mapping table name to number of rows deleted.
        """
        now = iso_now()
        results: Dict[str, int] = {}

        # Expired temp numbers
        cursor = await self.execute("DELETE FROM temp_numbers WHERE expires_at < ?", (now,))
        results["temp_numbers"] = cursor.rowcount

        # Old pending requests (>48h)
        cursor = await self.execute(
            "DELETE FROM pending_requests WHERE timestamp < datetime(?, '-48 hours')",
            (now,),
        )
        results["pending_requests"] = cursor.rowcount

        # Old offline queue (>7 days)
        cursor = await self.execute(
            "DELETE FROM offline_queue WHERE created_at < datetime(?, '-7 days')",
            (now,),
        )
        results["offline_queue"] = cursor.rowcount

        logger.info("Plugin DB cleanup: %s", results)
        return results


# ─── Initialization ─────────────────────────────────────────────────────


async def init_db(db_path: Path) -> PluginDatabase:
    """Create and initialize a PluginDatabase.

    Returns a ready-to-use database instance.
    """
    db = PluginDatabase(db_path)
    await db.connect()
    return db
