"""
AICQ Plugin Handshake Manager
===============================
Manages authenticated handshakes from the plugin side.

Features:
- Initiate handshake via temp number
- Accept/reject incoming handshake requests
- Session key rotation (after 100 messages or 1 hour)
- Incoming request queue management
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from .db import PluginDatabase, iso_now
from .identity_service import IdentityService
from .server_client import ServerClient
from .types import HandshakeProgress

logger = logging.getLogger("aicq.plugin.handshake")

# ─── Constants ──────────────────────────────────────────────────────────

_SESSION_KEY_ROTATION_MESSAGES = 100  # Rotate after this many messages
_SESSION_KEY_ROTATION_HOURS = 1       # Rotate after this many hours
_HANDSHAKE_EXPIRY_HOURS = 1           # Handshake expires after this many hours


class HandshakeManager:
    """Manages P2P handshake flows for the plugin.

    Coordinates the handshake protocol with the server:
    initiate → respond → confirm, establishing a shared session key.

    Parameters
    ----------
    db:
        Plugin database for persistence.
    identity:
        Identity service for signing and key exchange.
    server_client:
        Server client for communicating with the relay.
    """

    def __init__(
        self,
        db: PluginDatabase,
        identity: IdentityService,
        server_client: ServerClient,
    ) -> None:
        self.db = db
        self.identity = identity
        self.server_client = server_client

        # Active handshakes: session_id → HandshakeProgress
        self._active: Dict[str, HandshakeProgress] = {}

        # Session key rotation tracking
        self._rotation_threshold_messages = _SESSION_KEY_ROTATION_MESSAGES
        self._rotation_threshold_hours = _SESSION_KEY_ROTATION_HOURS

    # ── Initiate Handshake ──────────────────────────────────────────────

    async def initiate_handshake(self, temp_number: str) -> Dict[str, Any]:
        """Initiate a handshake with a target identified by temp number.

        Sends a handshake initiation request through the server.

        Parameters
        ----------
        temp_number:
            The temporary number of the target agent.

        Returns
        -------
        dict
            Handshake session details.

        Raises
        ------
        RuntimeError
            If identity not initialized or server communication fails.
        ValueError
            If the temp number is invalid or expired.
        """
        if not self.identity.is_initialized:
            raise RuntimeError("Identity not initialized")

        # Send initiation via server
        session_id = uuid.uuid4().hex
        now = iso_now()
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=_HANDSHAKE_EXPIRY_HOURS)).isoformat()

        # Create handshake progress tracker
        progress = HandshakeProgress(
            session_id=session_id,
            peer_id="",  # Will be filled when target responds
            status="initiated",
            started_at=now,
            expires_at=expires_at,
        )
        self._active[session_id] = progress

        # Send initiation to server
        try:
            result = await self.server_client.send_ws({
                "type": "handshake_initiate",
                "sessionId": session_id,
                "tempNumber": temp_number,
                "requesterId": self.identity.agent_id,
                "requesterPublicKey": self.identity.signing_public_key,
                "exchangePublicKey": self.identity.exchange_public_key,
            })

            logger.info("Handshake initiated: session %s via temp %s", session_id, temp_number)
            return {
                "session_id": session_id,
                "status": "initiated",
                "temp_number": temp_number,
                "expires_at": expires_at,
            }
        except Exception as exc:
            self._active.pop(session_id, None)
            raise RuntimeError(f"Handshake initiation failed: {exc}") from exc

    # ── Accept Handshake ────────────────────────────────────────────────

    async def accept_handshake(self, session_id: str) -> Dict[str, Any]:
        """Accept an incoming handshake request.

        Derives a shared session key and sends acceptance to the server.

        Parameters
        ----------
        session_id:
            The handshake session ID to accept.

        Returns
        -------
        dict
            Confirmation of acceptance with session key fingerprint.

        Raises
        ------
        ValueError
            If the session is not found or not in 'initiated' state.
        """
        # Look up pending request
        pending = await self.db.fetchone(
            "SELECT * FROM pending_requests WHERE session_id = ?",
            (session_id,),
        )
        if not pending:
            raise ValueError(f"No pending request found for session {session_id}")

        # Derive shared session key using X25519
        requester_public_key = pending["requester_public_key"]
        try:
            session_key = await self._derive_session_key(requester_public_key)
        except Exception as exc:
            raise RuntimeError(f"Session key derivation failed: {exc}") from exc

        # Save session
        await self.db.save_session(
            peer_id=pending["requester_id"],
            session_key=session_key,
        )

        # Add as friend
        await self.db.add_friend(
            friend_id=pending["requester_id"],
            public_key=requester_public_key,
            fingerprint=self.identity._compute_fingerprint(requester_public_key),
        )

        # Send acceptance to server
        await self.server_client.send_ws({
            "type": "handshake_accept",
            "sessionId": session_id,
            "responderId": self.identity.agent_id,
            "responderPublicKey": self.identity.signing_public_key,
            "exchangePublicKey": self.identity.exchange_public_key,
        })

        # Remove pending request
        await self.db.remove_pending_request(session_id)

        # Update progress
        progress = self._active.get(session_id)
        if progress:
            progress.status = "confirmed"
            progress.peer_id = pending["requester_id"]

        logger.info("Handshake accepted: session %s with %s", session_id, pending["requester_id"])
        return {
            "session_id": session_id,
            "status": "confirmed",
            "friend_id": pending["requester_id"],
            "session_established": True,
        }

    # ── Reject Handshake ────────────────────────────────────────────────

    async def reject_handshake(self, session_id: str) -> Dict[str, Any]:
        """Reject an incoming handshake request.

        Parameters
        ----------
        session_id:
            The handshake session ID to reject.

        Returns
        -------
        dict
            Confirmation of rejection.
        """
        # Remove pending request
        await self.db.remove_pending_request(session_id)

        # Notify server
        await self.server_client.send_ws({
            "type": "handshake_reject",
            "sessionId": session_id,
            "responderId": self.identity.agent_id,
        })

        # Update progress
        progress = self._active.get(session_id)
        if progress:
            progress.status = "failed"

        logger.info("Handshake rejected: session %s", session_id)
        return {
            "session_id": session_id,
            "status": "rejected",
        }

    # ── Session Key Rotation ────────────────────────────────────────────

    async def check_session_rotation(self, peer_id: str) -> bool:
        """Check if a session key needs rotation.

        Rotation is triggered when:
        - Message count exceeds the threshold (default 100)
        - Time since last rotation exceeds the threshold (default 1 hour)

        Parameters
        ----------
        peer_id:
            The peer's agent/node ID.

        Returns
        -------
        bool
            True if rotation was performed.
        """
        session = await self.db.load_session(peer_id)
        if not session:
            return False

        should_rotate = False

        # Check message count threshold
        if session["message_count"] >= self._rotation_threshold_messages:
            should_rotate = True
            logger.debug("Session key rotation triggered by message count for %s", peer_id)

        # Check time threshold
        if session.get("last_rotation"):
            last_rotation = datetime.fromisoformat(session["last_rotation"])
            elapsed = datetime.now(timezone.utc) - last_rotation
            if elapsed >= timedelta(hours=self._rotation_threshold_hours):
                should_rotate = True
                logger.debug("Session key rotation triggered by time for %s", peer_id)

        if should_rotate:
            await self._rotate_session_key(peer_id)
            return True

        return False

    async def _rotate_session_key(self, peer_id: str) -> None:
        """Rotate the session key for a peer.

        Generates a new session key and notifies the peer.
        """
        # Get friend's public key
        friend = await self.db.get_friend(peer_id)
        if not friend:
            logger.warning("Cannot rotate session key: friend %s not found", peer_id)
            return

        # Derive new session key
        new_key = await self._derive_session_key(friend["public_key"])

        # Save rotated key
        await self.db.rotate_session_key(peer_id, new_key)

        # Notify peer via server
        await self.server_client.send_ws({
            "type": "session_rotation",
            "peerId": peer_id,
            "newExchangePublicKey": self.identity.exchange_public_key,
        })

        logger.info("Session key rotated for peer %s", peer_id)

    # ── Session Key Derivation ──────────────────────────────────────────

    async def _derive_session_key(self, peer_public_key_b64: str) -> str:
        """Derive a shared session key from the peer's public exchange key.

        Uses X25519 key exchange with our private exchange key.

        Parameters
        ----------
        peer_public_key_b64:
            The peer's X25519 public key (base64).

        Returns
        -------
        str
            The derived session key (hex).
        """
        import base64
        import hashlib

        try:
            from nacl.public import PrivateKey, PublicKey
            our_private = PrivateKey(base64.b64decode(self.identity._exchange_secret_key))  # type: ignore
            their_public = PublicKey(base64.b64decode(peer_public_key_b64))
            from nacl.public import Box
            box = Box(our_private, their_public)
            shared = box.shared_key()
            return hashlib.sha256(shared).hexdigest()
        except ImportError:
            # Fallback: derive from public keys
            combined = f"{self.identity.exchange_public_key}:{peer_public_key_b64}"
            return hashlib.sha256(combined.encode()).hexdigest()

    # ── Incoming Request Handling ───────────────────────────────────────

    async def handle_incoming_request(self, data: Dict[str, Any]) -> None:
        """Handle an incoming handshake request from the server.

        Stores the request as pending for later acceptance/rejection.

        Parameters
        ----------
        data:
            WebSocket message data containing the request.
        """
        session_id = data.get("sessionId", "")
        requester_id = data.get("requesterId", "")
        requester_public_key = data.get("requesterPublicKey", "")

        if not session_id or not requester_id:
            logger.warning("Invalid handshake request: missing fields")
            return

        await self.db.save_pending_request(session_id, requester_id, requester_public_key)

        # Track progress
        progress = HandshakeProgress(
            session_id=session_id,
            peer_id=requester_id,
            status="initiated",
            started_at=iso_now(),
            expires_at=(datetime.now(timezone.utc) + timedelta(hours=_HANDSHAKE_EXPIRY_HOURS)).isoformat(),
        )
        self._active[session_id] = progress

        logger.info("Incoming handshake request from %s (session %s)", requester_id, session_id)

    # ── Query Methods ───────────────────────────────────────────────────

    async def get_pending_requests(self) -> List[Dict[str, Any]]:
        """List all pending handshake requests awaiting acceptance."""
        return await self.db.get_pending_requests()

    def get_active_handshakes(self) -> List[Dict[str, Any]]:
        """List all active handshake progress entries."""
        return [
            {
                "session_id": p.session_id,
                "peer_id": p.peer_id,
                "status": p.status,
                "started_at": p.started_at,
                "expires_at": p.expires_at,
            }
            for p in self._active.values()
        ]
