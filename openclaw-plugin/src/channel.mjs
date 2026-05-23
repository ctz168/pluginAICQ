/**
 * AICQ Channel Plugin — Core Channel Logic (ESM)
 *
 * Uses OpenClaw Channel Plugin SDK:
 *   - createChatChannelPlugin from openclaw/plugin-sdk/channel-core
 *   - createChannelPluginBase from openclaw/plugin-sdk/channel-core
 *
 * Wraps existing lib/ modules (identity, server-client, handshake, chat, database)
 * into the proper OpenClaw Channel plugin interface.
 */
import { createChatChannelPlugin, createChannelPluginBase } from 'openclaw/plugin-sdk/channel-core';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ── Configuration ──────────────────────────────────────────────────
const DATA_DIR = process.env.AICQ_DATA_DIR || path.join(os.homedir(), '.aicq-plugin');
const SERVER_URL = process.env.AICQ_SERVER_URL || 'https://aicq.online';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Lazy-loaded CommonJS modules ───────────────────────────────────
let _db = null;
let _identity = null;
let _serverClient = null;
let _handshake = null;
let _chat = null;
let _initialized = false;

/**
 * Initialize all plugin components (async, called once)
 */
async function ensureInitialized() {
  if (_initialized) return;

  const PluginDatabase = require('../lib/database');
  const IdentityManager = require('../lib/identity');
  const ServerClient = require('../lib/server-client');
  const HandshakeManager = require('../lib/handshake');
  const ChatManager = require('../lib/chat');

  // Initialize database
  _db = new PluginDatabase(DATA_DIR);
  await _db.init();
  console.log('[AICQ Channel] Database initialized');

  // Initialize managers
  _identity = new IdentityManager(_db);
  _serverClient = new ServerClient(_identity, _db, SERVER_URL);
  _handshake = new HandshakeManager(_identity, _serverClient, _db);
  _chat = new ChatManager(_identity, _serverClient, _db, path.join(DATA_DIR, 'uploads'));

  // Periodic cleanup
  setInterval(() => _db.cleanup(), 3600000);

  _initialized = true;
  console.log('[AICQ Channel] Plugin components initialized');
}

/**
 * Resolve account from OpenClaw config
 * Reads channels.<channel-id> section and returns a resolved account object
 */
function resolveAccount(cfg, accountId) {
  const section = (cfg.channels || {})[ 'aicq-chat' ];
  const token = section?.accountId || accountId || null;
  return {
    accountId: token,
    serverUrl: section?.serverUrl || SERVER_URL,
    autoAcceptFriends: section?.autoAcceptFriends ?? true,
    dmPolicy: section?.dmPolicy || 'allowlist',
    enabled: section?.enabled ?? true,
  };
}

/**
 * Inspect account without materializing secrets
 */
function inspectAccount(cfg, accountId) {
  const section = (cfg.channels || {})[ 'aicq-chat' ];
  return {
    enabled: section?.enabled ?? true,
    configured: Boolean(section?.accountId || accountId),
    hasAccountId: Boolean(section?.accountId || accountId),
  };
}

// ── Build the Channel Plugin using SDK ──────────────────────────────
export const aicqChatPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: 'aicq-chat',
    setup: {
      resolveAccount,
      inspectAccount,
    },
  }),

  // DM security: who can message the bot
  security: {
    dm: {
      channelKey: 'aicq-chat',
      resolvePolicy: (account) => account.dmPolicy || 'allowlist',
      resolveAllowFrom: async (account) => {
        // Only friends in the contact list can send DMs
        await ensureInitialized();
        if (!_identity || !account.accountId) return [];
        const friends = _db.listFriends(account.accountId);
        return friends.map(f => f.id || f.friend_id);
      },
      defaultPolicy: 'allowlist',
    },
  },

  // Pairing: DM approval flow for new contacts
  pairing: {
    text: {
      idLabel: 'AICQ Account ID',
      message: 'Share this pairing code with the other party to verify your identity:',
      generate: async ({ target, code }) => {
        await ensureInitialized();
        if (_handshake && target) {
          try {
            await _serverClient.ensureAuth(target);
            const result = await _handshake.generateFriendCode(target);
            return { code: result.number, instructions: `Share this pairing code: ${result.number}` };
          } catch (e) {
            // Fallback to the generated code
          }
        }
        return { code, instructions: `Share this pairing code: ${code}` };
      },
      verify: async ({ accountId, peerCode }) => {
        await ensureInitialized();
        try {
          const result = await _handshake.addFriendByCode(accountId, peerCode);
          return { success: true, peerId: result.peer_id || result.friend_id || peerCode };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
    },
  },

  // Threading: how replies are delivered
  threading: {
    topLevelReplyToMode: 'reply',
  },

  // Outbound: send messages to the platform
  outbound: {
    attachedResults: {
      sendText: async (params) => {
        await ensureInitialized();
        const result = await _chat.sendMessage(
          params.fromAccountId || params.accountId,
          params.to,
          params.text,
          { isGroup: false }
        );
        return { messageId: result?.message_id || result?.id || `msg_${Date.now()}` };
      },
    },
    base: {
      sendMedia: async (params) => {
        await ensureInitialized();
        const result = await _chat.sendMessage(
          params.fromAccountId || params.accountId,
          params.to,
          params.mediaUrl || params.filePath,
          { type: params.mediaType || 'file', isGroup: false }
        );
        return { messageId: result?.message_id || result?.id || `msg_${Date.now()}` };
      },
    },
  },

  // Lifecycle: account management
  lifecycle: {
    onAccountCreate: async (accountId) => {
      await ensureInitialized();
      let agentIdentity = _identity.loadAgent(accountId);
      if (!agentIdentity) {
        agentIdentity = _identity.createAgent(accountId, `agent-${accountId.slice(0, 8)}`);
      }
      try {
        await _serverClient.start(accountId);
      } catch (e) {
        console.error('[AICQ Channel] Server connection failed for account:', accountId, e.message);
      }
    },
    onAccountDelete: async (accountId) => {
      try {
        _serverClient.disconnect();
      } catch (e) {}
      _identity.deleteAgent(accountId);
    },
    onShutdown: async () => {
      try {
        _serverClient.stop();
      } catch (e) {}
      console.log('[AICQ Channel] Shutdown complete');
    },
  },

  // Inbound: process incoming messages (used when AICQ server pushes messages)
  inbound: {
    onText: async (message) => {
      const { toAccountId, fromPeerId, encryptedContent } = message;
      await ensureInitialized();

      let content = encryptedContent || message.content || message.payload || '';
      const session = _db.loadSession(toAccountId, fromPeerId);
      if (session && session.session_key && typeof content === 'string') {
        try {
          const { decryptMessage } = require('../lib/crypto');
          content = decryptMessage(content, session.session_key);
        } catch (e) {
          // Might be plaintext, keep as is
        }
      }

      return {
        text: typeof content === 'string' ? content : JSON.stringify(content),
        metadata: {
          fromPeerId,
          timestamp: message.timestamp,
        },
      };
    },
    onMedia: async (message) => {
      await ensureInitialized();
      let content = message.encryptedContent || message.content || '';
      const session = _db.loadSession(message.toAccountId, message.fromPeerId);
      if (session && session.session_key && typeof content === 'string') {
        try {
          const { decryptMessage } = require('../lib/crypto');
          content = decryptMessage(content, session.session_key);
        } catch (e) {}
      }
      return {
        mediaUrl: content,
        mediaType: message.mediaType || 'file',
        metadata: { fromPeerId: message.fromPeerId },
      };
    },
  },
});

// Export for gateway handlers to access managers
export { ensureInitialized, _db, _identity, _serverClient, _handshake, _chat };
