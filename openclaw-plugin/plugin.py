"""
AICQ Plugin — Main plugin class.

Wires together all plugin sub-modules: identity, server client,
handshake, P2P, encrypted chat, file transfer, tools, hooks,
gateway methods, management UI, and auto-update service.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Optional

from .config import load_plugin_config, PluginConfig
from .db import PluginDatabase
from .identity_service import IdentityService
from .server_client import ServerClient
from .handshake_manager import HandshakeManager
from .p2p.connection_manager import P2PConnectionManager
from .channels.encrypted_chat import EncryptedChatChannel
from .file_transfer.transfer_manager import FileTransferManager
from .hooks.before_tool_call import BeforeToolCallHook
from .hooks.message_sending import MessageSendingHook
from .tools.chat_friend import ChatFriendTool
from .tools.chat_send import ChatSendTool
from .tools.chat_export_key import ChatExportKeyTool
from .services.auto_update_service import AutoUpdateService
from .ui.management_server import ManagementServer
from .gateway import AICQGateway
from .types import PluginState


class AICQPlugin:
    """AICQ Encrypted Chat Plugin for OpenClaw.

    Provides end-to-end encrypted chat capabilities as an OpenClaw plugin,
    with tools, hooks, gateway methods, and a management UI.

    Usage::

        plugin = AICQPlugin()
        await plugin.initialize()
        await plugin.start()
        # ... runs until stop()
        await plugin.stop()
    """

    def __init__(self, config_overrides: Optional[dict] = None):
        self._config = load_plugin_config(config_overrides)
        self._state = PluginState.DISCONNECTED
        self._db: Optional[PluginDatabase] = None
        self._identity: Optional[IdentityService] = None
        self._server_client: Optional[ServerClient] = None
        self._handshake: Optional[HandshakeManager] = None
        self._p2p: Optional[P2PConnectionManager] = None
        self._chat: Optional[EncryptedChatChannel] = None
        self._file_transfer: Optional[FileTransferManager] = None
        self._before_tool_call: Optional[BeforeToolCallHook] = None
        self._message_sending: Optional[MessageSendingHook] = None
        self._tool_friend: Optional[ChatFriendTool] = None
        self._tool_send: Optional[ChatSendTool] = None
        self._tool_export_key: Optional[ChatExportKeyTool] = None
        self._auto_update: Optional[AutoUpdateService] = None
        self._mgmt_server: Optional[ManagementServer] = None
        self._gateway: Optional[AICQGateway] = None
        self._initialized = False

    @property
    def state(self) -> PluginState:
        return self._state

    # ──────────────── Initialise ────────────────

    async def initialize(self) -> None:
        """Initialise all plugin sub-modules."""
        if self._initialized:
            return

        # Database
        data_dir = os.path.expanduser(self._config.data_dir)
        os.makedirs(data_dir, exist_ok=True)
        self._db = PluginDatabase(data_dir)
        await self._db.open()

        # Identity
        self._identity = IdentityService(self._db)
        await self._identity.initialize(self._config.agent_id)

        # Server client
        self._server_client = ServerClient(self._config.server_url, self._db)

        # Handshake
        self._handshake = HandshakeManager(
            self._server_client, self._identity, self._db
        )

        # P2P
        self._p2p = P2PConnectionManager(self._db)

        # Encrypted chat channel
        self._chat = EncryptedChatChannel(self._db, self._identity)
        self._chat.set_server_client(self._server_client)

        # File transfer
        self._file_transfer = FileTransferManager()

        # Hooks
        self._before_tool_call = BeforeToolCallHook(self._config.max_friends)
        self._message_sending = MessageSendingHook()

        # Tools
        self._tool_friend = ChatFriendTool(self._db, self._server_client, self._handshake)
        self._tool_send = ChatSendTool(self._chat)
        self._tool_export_key = ChatExportKeyTool(self._identity)

        # Gateway
        self._gateway = AICQGateway(
            self._db, self._identity, self._handshake, self._server_client
        )

        # Management UI
        self._mgmt_server = ManagementServer(self._db)

        # Auto-update
        self._auto_update = AutoUpdateService()

        self._initialized = True
        print("[AICQPlugin] Initialised")

    # ──────────────── Start ────────────────

    async def start(self) -> None:
        """Start the plugin: connect to server, start management UI."""
        if not self._initialized:
            await self.initialize()

        self._state = PluginState.CONNECTING

        try:
            await self._server_client.connect()
            self._state = PluginState.CONNECTED
        except Exception as exc:
            print(f"[AICQPlugin] Server connection failed: {exc}")
            self._state = PluginState.ERROR

        # Start management UI
        await self._mgmt_server.start()

        # Start auto-update service
        await self._auto_update.start()

        print("[AICQPlugin] Started")

    # ──────────────── Stop ────────────────

    async def stop(self) -> None:
        """Gracefully stop all plugin services."""
        await self._auto_update.stop()
        await self._mgmt_server.stop()
        self._file_transfer.destroy()
        self._chat.destroy()
        self._p2p.destroy()
        await self._server_client.disconnect()
        await self._db.close()

        self._state = PluginState.DISCONNECTED
        self._initialized = False
        print("[AICQPlugin] Stopped")

    # ──────────────── Tool dispatch ────────────────

    async def call_tool(self, tool_name: str, **kwargs) -> dict:
        """Dispatch a tool call by name."""
        # Permission check
        allowed, reason = await self._before_tool_call.check(
            tool_name,
            friend_id=kwargs.get("friend_id"),
            friend_count=len(await self._db.get_all_friends()),
            permissions=kwargs.get("permissions"),
        )
        if not allowed:
            return {"error": reason}

        if tool_name == "chat-friend":
            return await self._tool_friend.execute(**kwargs)
        elif tool_name == "chat-send":
            return await self._tool_send.execute(**kwargs)
        elif tool_name == "chat-export-key":
            return await self._tool_export_key.execute(**kwargs)
        else:
            return {"error": f"Unknown tool: {tool_name}"}

    # ──────────────── Gateway dispatch ────────────────

    async def call_gateway(self, method: str, **kwargs) -> dict:
        """Dispatch a gateway method call."""
        return await self._gateway.dispatch(method, **kwargs)


# ──────────────── CLI Entry Point ────────────────

async def _plugin_main() -> None:
    """Standalone plugin runner."""
    plugin = AICQPlugin()
    await plugin.initialize()
    await plugin.start()

    print("\nAICQ Plugin running. Press Ctrl+C to stop.")
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        await plugin.stop()


if __name__ == "__main__":
    asyncio.run(_plugin_main())
