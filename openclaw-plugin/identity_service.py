"""
AICQ Plugin Identity Service
==============================
Manages Ed25519 signing keys and X25519 exchange keys for AI agents.

Features:
- Load or generate Ed25519 + X25519 key pairs
- QR-based private key export/import (password-encrypted, 60s expiry)
- Rate-limited key export (3 per 5 minutes)
- Key rotation support
- Uses shared/crypto library for cryptographic operations
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import time
from collections import deque
from typing import Any, Dict, Optional, Tuple

from .db import PluginDatabase, iso_now
from .types import PluginConfig

logger = logging.getLogger("aicq.plugin.identity")

# ─── Crypto imports from shared library ─────────────────────────────────

try:
    import sys
    from pathlib import Path
    _shared_path = str(Path(__file__).resolve().parent.parent / "shared")
    if _shared_path not in sys.path:
        sys.path.insert(0, _shared_path)
    from crypto import (
        generate_signing_keypair,
        generate_exchange_keypair,
        sign_message,
        verify_signature,
        compute_fingerprint,
        encrypt_data,
        decrypt_data,
        derive_session_key,
    )
    _HAS_SHARED_CRYPTO = True
except ImportError:
    _HAS_SHARED_CRYPTO = False
    logger.warning("shared/crypto not available, using pynacl fallback")

# ─── Fallback crypto using pynacl ──────────────────────────────────────

if not _HAS_SHARED_CRYPTO:
    from nacl.signing import SigningKey, VerifyKey
    from nacl.public import PrivateKey, PublicKey, Box, SealedBox
    from nacl.encoding import Base64Encoder
    from nacl.utils import random as nacl_random

    def _generate_signing_keypair() -> Tuple[str, str]:
        """Generate Ed25519 signing keypair, return (public_b64, secret_b64)."""
        sk = SigningKey.generate()
        pk = sk.verify_key
        return (
            base64.b64encode(bytes(pk)).decode(),
            base64.b64encode(bytes(sk)).decode(),
        )

    def _generate_exchange_keypair() -> Tuple[str, str]:
        """Generate X25519 exchange keypair, return (public_b64, secret_b64)."""
        sk = PrivateKey.generate()
        pk = sk.public_key
        return (
            base64.b64encode(bytes(pk)).decode(),
            base64.b64encode(bytes(sk)).decode(),
        )

    def _compute_fingerprint(public_key_b64: str) -> str:
        """Compute SHA-256 fingerprint of a public key."""
        digest = hashlib.sha256(base64.b64decode(public_key_b64)).hexdigest()
        return ":".join(digest[i:i+2] for i in range(0, len(digest), 2))

    def _sign_message(message: str, secret_key_b64: str) -> str:
        """Sign a message with Ed25519 key."""
        sk = SigningKey(base64.b64decode(secret_key_b64))
        signed = sk.sign(message.encode("utf-8"))
        return base64.b64encode(signed.signature).decode()

    def _verify_signature(message: str, signature_b64: str, public_key_b64: str) -> bool:
        """Verify an Ed25519 signature."""
        try:
            vk = VerifyKey(base64.b64decode(public_key_b64))
            vk.verify(message.encode("utf-8"), base64.b64decode(signature_b64))
            return True
        except Exception:
            return False


# ─── Rate Limiter for Key Export ────────────────────────────────────────


class RateLimiter:
    """Sliding-window rate limiter.

    Allows a maximum number of actions within a time window.
    Used to limit private key export operations.
    """

    def __init__(self, max_actions: int = 3, window_seconds: float = 300.0) -> None:
        self.max_actions = max_actions
        self.window_seconds = window_seconds
        self._timestamps: deque[float] = deque()

    def check(self) -> bool:
        """Return True if the action is allowed, False if rate-limited."""
        now = time.monotonic()
        cutoff = now - self.window_seconds
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.popleft()
        if len(self._timestamps) >= self.max_actions:
            return False
        self._timestamps.append(now)
        return True

    @property
    def remaining(self) -> int:
        """Number of remaining actions in the current window."""
        now = time.monotonic()
        cutoff = now - self.window_seconds
        active = sum(1 for t in self._timestamps if t >= cutoff)
        return max(0, self.max_actions - active)


# ─── Identity Service ──────────────────────────────────────────────────


class IdentityService:
    """Manages cryptographic identity for an AI agent.

    Handles key generation, loading, export (QR), import, and rotation.

    Parameters
    ----------
    db:
        Plugin database instance.
    config:
        Plugin configuration.
    """

    def __init__(self, db: PluginDatabase, config: PluginConfig) -> None:
        self.db = db
        self.config = config
        self._export_rate_limiter = RateLimiter(max_actions=3, window_seconds=300.0)

        # In-memory key cache
        self._signing_public_key: Optional[str] = None
        self._signing_secret_key: Optional[str] = None
        self._exchange_public_key: Optional[str] = None
        self._exchange_secret_key: Optional[str] = None
        self._fingerprint: Optional[str] = None
        self._agent_id: Optional[str] = None

    @property
    def agent_id(self) -> Optional[str]:
        """The current agent ID."""
        return self._agent_id

    @property
    def signing_public_key(self) -> Optional[str]:
        """The Ed25519 signing public key (base64)."""
        return self._signing_public_key

    @property
    def exchange_public_key(self) -> Optional[str]:
        """The X25519 exchange public key (base64)."""
        return self._exchange_public_key

    @property
    def fingerprint(self) -> Optional[str]:
        """SHA-256 fingerprint of the signing public key."""
        return self._fingerprint

    @property
    def is_initialized(self) -> bool:
        """Whether the identity has been loaded or generated."""
        return self._agent_id is not None

    # ── Initialize ──────────────────────────────────────────────────────

    async def initialize(self, agent_id: str) -> None:
        """Load or generate identity keys for the given agent.

        If keys exist in the database they are loaded; otherwise new
        Ed25519 signing + X25519 exchange key pairs are generated and
        stored.

        Parameters
        ----------
        agent_id:
            Unique identifier for this agent.
        """
        self._agent_id = agent_id

        # Try to load existing identity
        identity = await self.db.load_identity(agent_id)
        if identity:
            self._signing_public_key = identity["signing_public_key"]
            self._signing_secret_key = identity["signing_secret_key"]
            self._exchange_public_key = identity["exchange_public_key"]
            self._exchange_secret_key = identity["exchange_secret_key"]
            self._fingerprint = self._compute_fingerprint(self._signing_public_key)
            logger.info("Identity loaded for agent %s (fingerprint: %s...)", agent_id, self._fingerprint[:16])
            return

        # Generate new keys
        if _HAS_SHARED_CRYPTO:
            sign_pk, sign_sk = generate_signing_keypair()
            ex_pk, ex_sk = generate_exchange_keypair()
        else:
            sign_pk, sign_sk = _generate_signing_keypair()
            ex_pk, ex_sk = _generate_exchange_keypair()

        self._signing_public_key = sign_pk
        self._signing_secret_key = sign_sk
        self._exchange_public_key = ex_pk
        self._exchange_secret_key = ex_sk
        self._fingerprint = self._compute_fingerprint(sign_pk)

        # Save to database
        await self.db.save_identity(
            agent_id=agent_id,
            signing_public_key=sign_pk,
            signing_secret_key=sign_sk,
            exchange_public_key=ex_pk,
            exchange_secret_key=ex_sk,
        )
        logger.info("New identity generated for agent %s (fingerprint: %s...)", agent_id, self._fingerprint[:16])

    # ── Fingerprint ─────────────────────────────────────────────────────

    @staticmethod
    def _compute_fingerprint(public_key_b64: str) -> str:
        """Compute SHA-256 fingerprint of a public key."""
        if _HAS_SHARED_CRYPTO:
            return compute_fingerprint(public_key_b64)
        return _compute_fingerprint(public_key_b64)

    # ── Signing ─────────────────────────────────────────────────────────

    def sign(self, message: str) -> str:
        """Sign a message with the agent's Ed25519 signing key.

        Returns the signature as base64.

        Raises
        ------
        RuntimeError
            If identity has not been initialized.
        """
        if not self._signing_secret_key:
            raise RuntimeError("Identity not initialized")
        if _HAS_SHARED_CRYPTO:
            return sign_message(message, self._signing_secret_key)
        return _sign_message(message, self._signing_secret_key)

    @staticmethod
    def verify(message: str, signature_b64: str, public_key_b64: str) -> bool:
        """Verify an Ed25519 signature against a public key."""
        if _HAS_SHARED_CRYPTO:
            return verify_signature(message, signature_b64, public_key_b64)
        return _verify_signature(message, signature_b64, public_key_b64)

    # ── Key Export (QR) ─────────────────────────────────────────────────

    async def export_private_key_qr(self, password: str) -> Dict[str, Any]:
        """Export the private key as a password-encrypted QR payload.

        The export is rate-limited (3 per 5 minutes) and the payload
        expires after 60 seconds.

        Parameters
        ----------
        password:
            User-provided password to encrypt the private keys.

        Returns
        -------
        dict
            Contains ``qr_data`` (string for QR encoding), ``expires_at``,
            and ``fingerprint``.

        Raises
        ------
        RuntimeError
            If identity not initialized or rate limit exceeded.
        """
        if not self.is_initialized:
            raise RuntimeError("Identity not initialized")

        if not self._export_rate_limiter.check():
            raise RuntimeError(
                f"Rate limit exceeded: key export limited to "
                f"{self._export_rate_limiter.max_actions} per "
                f"{int(self._export_rate_limiter.window_seconds)}s"
            )

        # Build payload
        payload = {
            "agent_id": self._agent_id,
            "signing_secret_key": self._signing_secret_key,
            "exchange_secret_key": self._exchange_secret_key,
            "signing_public_key": self._signing_public_key,
            "exchange_public_key": self._exchange_public_key,
            "exported_at": iso_now(),
            "expires_in": 60,  # seconds
        }

        # Encrypt with password
        payload_json = json.dumps(payload, separators=(",", ":"))
        encrypted = self._encrypt_with_password(payload_json, password)

        # Generate QR data string
        qr_data = f"aicq-key-v1:{encrypted}"

        logger.info("Private key exported for agent %s (rate-limited)", self._agent_id)
        return {
            "qr_data": qr_data,
            "expires_at": iso_now(),  # Already expired concept in 60s
            "fingerprint": self._fingerprint,
            "remaining_exports": self._export_rate_limiter.remaining,
        }

    async def import_private_key_qr(self, qr_data: str, password: str) -> None:
        """Import a private key from a QR-encoded encrypted payload.

        Parameters
        ----------
        qr_data:
            The QR data string (``aicq-key-v1:...``).
        password:
            Password to decrypt the payload.

        Raises
        ------
        ValueError
            If the QR data is invalid or decryption fails.
        """
        if not qr_data.startswith("aicq-key-v1:"):
            raise ValueError("Invalid QR data format")

        encrypted = qr_data[len("aicq-key-v1:"):]
        try:
            decrypted = self._decrypt_with_password(encrypted, password)
            payload = json.loads(decrypted)
        except Exception as exc:
            raise ValueError(f"Decryption failed: {exc}") from exc

        # Validate required fields
        required_fields = ["agent_id", "signing_secret_key", "exchange_secret_key",
                          "signing_public_key", "exchange_public_key"]
        for field_name in required_fields:
            if field_name not in payload:
                raise ValueError(f"Missing field in key payload: {field_name}")

        # Check expiry
        if "exported_at" in payload and "expires_in" in payload:
            from datetime import datetime, timezone, timedelta
            exported = datetime.fromisoformat(payload["exported_at"])
            expiry = exported + timedelta(seconds=payload["expires_in"])
            if datetime.now(timezone.utc) > expiry:
                raise ValueError("Key export has expired")

        # Import keys
        self._agent_id = payload["agent_id"]
        self._signing_public_key = payload["signing_public_key"]
        self._signing_secret_key = payload["signing_secret_key"]
        self._exchange_public_key = payload["exchange_public_key"]
        self._exchange_secret_key = payload["exchange_secret_key"]
        self._fingerprint = self._compute_fingerprint(self._signing_public_key)

        # Save to database
        await self.db.save_identity(
            agent_id=self._agent_id,
            signing_public_key=self._signing_public_key,
            signing_secret_key=self._signing_secret_key,
            exchange_public_key=self._exchange_public_key,
            exchange_secret_key=self._exchange_secret_key,
        )
        logger.info("Private key imported for agent %s", self._agent_id)

    # ── Key Rotation ────────────────────────────────────────────────────

    async def rotate_keys(self) -> Dict[str, str]:
        """Generate new key pairs, replacing the current ones.

        The old keys are replaced in the database. Returns the new
        public keys and fingerprint.

        Raises
        ------
        RuntimeError
            If identity not initialized.
        """
        if not self.is_initialized:
            raise RuntimeError("Identity not initialized")

        if _HAS_SHARED_CRYPTO:
            sign_pk, sign_sk = generate_signing_keypair()
            ex_pk, ex_sk = generate_exchange_keypair()
        else:
            sign_pk, sign_sk = _generate_signing_keypair()
            ex_pk, ex_sk = _generate_exchange_keypair()

        old_fingerprint = self._fingerprint
        self._signing_public_key = sign_pk
        self._signing_secret_key = sign_sk
        self._exchange_public_key = ex_pk
        self._exchange_secret_key = ex_sk
        self._fingerprint = self._compute_fingerprint(sign_pk)

        await self.db.save_identity(
            agent_id=self._agent_id,  # type: ignore[arg-type]
            signing_public_key=sign_pk,
            signing_secret_key=sign_sk,
            exchange_public_key=ex_pk,
            exchange_secret_key=ex_sk,
        )
        logger.info(
            "Keys rotated for agent %s: %s... -> %s...",
            self._agent_id,
            (old_fingerprint or "")[:16],
            self._fingerprint[:16],
        )
        return {
            "signing_public_key": sign_pk,
            "exchange_public_key": ex_pk,
            "fingerprint": self._fingerprint,
        }

    # ── Identity Info ───────────────────────────────────────────────────

    def get_info(self) -> Dict[str, Any]:
        """Return identity information (public keys only, no secrets)."""
        return {
            "agent_id": self._agent_id,
            "signing_public_key": self._signing_public_key,
            "exchange_public_key": self._exchange_public_key,
            "fingerprint": self._fingerprint,
            "is_initialized": self.is_initialized,
        }

    # ── Password-based encryption helpers ───────────────────────────────

    @staticmethod
    def _encrypt_with_password(plaintext: str, password: str) -> str:
        """Encrypt plaintext with a password using NaCl sealed box.

        Derives a key from the password using HKDF-like approach.
        """
        try:
            import nacl.secret
            import nacl.utils
            import nacl.pwhash

            # Derive key from password
            salt = nacl.utils.random(nacl.pwhash.argon2i.SALTBYTES)
            key = nacl.pwhash.argon2i.kdf(
                nacl.secret.SecretBox.KEY_SIZE,
                password.encode("utf-8"),
                salt,
            )

            box = nacl.secret.SecretBox(key)
            encrypted = box.encrypt(plaintext.encode("utf-8"))

            # Combine salt + encrypted
            combined = salt + encrypted
            return base64.b64encode(combined).decode()
        except ImportError:
            # Fallback: simple XOR-based (NOT for production)
            import hashlib
            key = hashlib.sha256(password.encode()).digest()
            data = plaintext.encode("utf-8")
            encrypted = bytes(a ^ b for a, b in zip(data, key * (len(data) // len(key) + 1)))
            return base64.b64encode(encrypted).decode()

    @staticmethod
    def _decrypt_with_password(ciphertext_b64: str, password: str) -> str:
        """Decrypt ciphertext with a password."""
        try:
            import nacl.secret
            import nacl.pwhash

            combined = base64.b64decode(ciphertext_b64)

            salt = combined[:nacl.pwhash.argon2i.SALTBYTES]
            encrypted = combined[nacl.pwhash.argon2i.SALTBYTES:]

            key = nacl.pwhash.argon2i.kdf(
                nacl.secret.SecretBox.KEY_SIZE,
                password.encode("utf-8"),
                salt,
            )

            box = nacl.secret.SecretBox(key)
            decrypted = box.decrypt(encrypted)
            return decrypted.decode("utf-8")
        except ImportError:
            import hashlib
            key = hashlib.sha256(password.encode()).digest()
            data = base64.b64decode(ciphertext_b64)
            decrypted = bytes(a ^ b for a, b in zip(data, key * (len(data) // len(key) + 1)))
            return decrypted.decode("utf-8")
