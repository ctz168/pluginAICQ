"""AICQ Plugin — message_sending hook for auto-encrypting messages."""

from __future__ import annotations

from typing import Optional


class MessageSendingHook:
    """Hook that auto-encrypts messages on the encrypted-chat channel.

    When a message is about to be sent on the 'encrypted-chat' channel,
    this hook ensures it is encrypted with the appropriate session key.
    """

    def __init__(self, encrypt_fn=None):
        self._encrypt_fn = encrypt_fn

    def set_encrypt_function(self, fn) -> None:
        self._encrypt_fn = fn

    async def process(self, channel: str, friend_id: str, content: str) -> Optional[bytes]:
        """Process a message before sending.

        If the channel is 'encrypted-chat', encrypts the message.
        Otherwise returns None (no transformation).
        """
        if channel != "encrypted-chat":
            return None

        if not self._encrypt_fn:
            return None

        return await self._encrypt_fn(friend_id, content)
