"""AICQ Plugin — chat-friend tool for managing friends."""

from __future__ import annotations

import asyncio
from typing import Optional


class ChatFriendTool:
    """OpenClaw tool for managing friends in the AICQ system.

    Provides: add, list, remove friends and request/revoke temp numbers.
    """

    name = "chat-friend"
    description = "Manage friends: add, list, remove, request temp numbers"

    def __init__(self, db, server_client, handshake_manager):
        self._db = db
        self._server_client = server_client
        self._handshake = handshake_manager

    async def execute(self, action: str, **kwargs) -> dict:
        """Execute a friend management action.

        Actions:
            - add: Add a friend by temp number
            - list: List all friends
            - remove: Remove a friend by ID
            - request_temp: Request a temp number
            - revoke_temp: Revoke a temp number
        """
        if action == "add":
            return await self._add_friend(kwargs.get("temp_number", ""))
        elif action == "list":
            return await self._list_friends()
        elif action == "remove":
            return await self._remove_friend(kwargs.get("friend_id", ""))
        elif action == "request_temp":
            return await self._request_temp()
        elif action == "revoke_temp":
            return await self._revoke_temp(kwargs.get("number", ""))
        else:
            return {"error": f"Unknown action: {action}"}

    async def _add_friend(self, temp_number: str) -> dict:
        if not temp_number:
            return {"error": "temp_number is required"}
        try:
            await self._handshake.initiate_handshake(temp_number)
            return {"success": True, "message": f"Friend request sent for {temp_number}"}
        except Exception as exc:
            return {"error": str(exc)}

    async def _list_friends(self) -> dict:
        friends = await self._db.get_all_friends()
        return {
            "count": len(friends),
            "friends": [
                {
                    "id": f.id,
                    "fingerprint": f.fingerprint,
                    "is_online": f.is_online,
                    "friend_type": f.friend_type,
                }
                for f in friends
            ],
        }

    async def _remove_friend(self, friend_id: str) -> dict:
        if not friend_id:
            return {"error": "friend_id is required"}
        await self._db.remove_friend(friend_id)
        await self._db.remove_session(friend_id)
        return {"success": True}

    async def _request_temp(self) -> dict:
        try:
            result = await self._server_client.request_temp_number()
            return {"number": result.get("number", "")}
        except Exception as exc:
            return {"error": str(exc)}

    async def _revoke_temp(self, number: str) -> dict:
        if not number:
            return {"error": "number is required"}
        try:
            await self._server_client.revoke_temp_number(number)
            await self._db.remove_temp_number(number)
            return {"success": True}
        except Exception as exc:
            return {"error": str(exc)}
