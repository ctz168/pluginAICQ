"""AICQ Plugin — before_tool_call hook for permission checking."""

from __future__ import annotations

from typing import Optional


class BeforeToolCallHook:
    """Permission checking hook invoked before any tool call.

    Enforces:
    - Friend limit
    - Chat/exec permission requirements
    - Rate limiting
    """

    def __init__(self, max_friends: int = 200, rate_limit_per_min: int = 60):
        self._max_friends = max_friends
        self._rate_limit = rate_limit_per_min
        self._call_times: list[float] = []

    async def check(self, tool_name: str, friend_id: Optional[str] = None,
                    friend_count: int = 0, permissions: Optional[list[str]] = None) -> tuple[bool, str]:
        """Check if a tool call is allowed.

        Returns (allowed, reason) tuple.
        """
        import time
        now = time.time()

        # Rate limiting
        self._call_times = [t for t in self._call_times if now - t < 60]
        if len(self._call_times) >= self._rate_limit:
            return False, f"Rate limit: max {self._rate_limit} calls per minute"

        self._call_times.append(now)

        # Friend limit check for add operations
        if tool_name == "chat-friend" and friend_count >= self._max_friends:
            return False, f"Friend limit reached ({self._max_friends})"

        # Permission check
        if permissions is not None:
            if tool_name == "chat-send" and "chat" not in permissions:
                return False, "Friend does not have chat permission"
            if tool_name in ("exec", "shell") and "exec" not in permissions:
                return False, "Friend does not have exec permission"

        return True, ""
