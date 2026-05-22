"""AICQ Plugin — chat-send tool for sending encrypted messages."""

from __future__ import annotations

from typing import Optional


class ChatSendTool:
    """OpenClaw tool for sending encrypted chat messages."""

    name = "chat-send"
    description = "Send encrypted text or file-info messages to friends"

    def __init__(self, encrypted_chat):
        self._chat = encrypted_chat

    async def execute(self, friend_id: str, content: str,
                      message_type: str = "text") -> dict:
        """Send an encrypted message to a friend.

        Args:
            friend_id: The friend's node/agent ID.
            content: The message content.
            message_type: 'text' or 'file-info'.
        """
        if not friend_id or not content:
            return {"error": "friend_id and content are required"}

        try:
            msg = await self._chat.send_message(friend_id, content)
            return {
                "success": True,
                "message_id": msg.id,
                "status": msg.status,
            }
        except Exception as exc:
            return {"error": str(exc)}
