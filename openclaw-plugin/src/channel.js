/**
 * AICQ Channel Plugin — Core Channel Logic
 *
 * Uses the official OpenClaw Channel Plugin SDK:
 *   createChatChannelPlugin + createChannelPluginBase
 *
 * Architecture: In-process Channel (no sidecar, no independent port)
 *
 * The runtime store is a mutable object populated by registerFull() in
 * index.js. This keeps the channel-plugin object safe to import during
 * setup-only / discovery modes without pulling in transport clients or
 * database handles.
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";

// ── Mutable runtime store ────────────────────────────────────────────
// Populated lazily by the registerFull() callback in index.js.
// Adapters that need runtime state check these before acting.
export const runtime = {
  db: null,
  identity: null,
  serverClient: null,
  handshake: null,
  chat: null,
  dataDir: null,
  serverUrl: null,
  handleGateway: null,
  _initialized: false,
};

// ── Resolved account type ────────────────────────────────────────────
// This is the object returned by resolveAccount() and consumed by
// security / pairing / outbound adapters.

/**
 * Read the AICQ channel section from OpenClaw config and return a typed
 * account object.  This is the setup-safe resolver — no network or DB
 * side effects.
 */
function resolveAccount(cfg, accountId) {
  const section = (cfg.channels || {})["aicq-chat"] || {};
  const resolvedAccountId = accountId || section.accountId || null;

  if (!resolvedAccountId) {
    throw new Error(
      "aicq-chat: accountId is required (set channels.aicq-chat.accountId)"
    );
  }

  return {
    accountId: resolvedAccountId,
    serverUrl: section.serverUrl || "https://aicq.online",
    autoAcceptFriends: section.autoAcceptFriends ?? true,
    enabled: section.enabled ?? true,
    dmPolicy: section.dmPolicy || "allowlist",
    allowFrom: section.allowFrom ?? [],
  };
}

/**
 * Lightweight account inspection for status / health / setup surfaces.
 * Must not materialise secrets or start transports.
 */
function inspectAccount(cfg, accountId) {
  const section = (cfg.channels || {})["aicq-chat"] || {};
  const hasAccountId = Boolean(section.accountId || accountId);
  return {
    enabled: hasAccountId && section.enabled !== false,
    configured: hasAccountId,
    accountStatus: hasAccountId ? "available" : "missing",
  };
}

// ── Build the channel plugin ─────────────────────────────────────────

const _plugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "aicq-chat",

    setup: {
      resolveAccount,
      inspectAccount,
    },

    // Gateway method descriptors — these are the method names the plugin
    // will register via registerFull(). Declaring them here lets OpenClaw
    // surface them in discovery / status surfaces before full activation.
    gatewayMethodDescriptors: [
      "aicq.status",
      "aicq.friends.list",
      "aicq.friends.add",
      "aicq.friends.remove",
      "aicq.friends.requests",
      "aicq.friends.acceptRequest",
      "aicq.friends.rejectRequest",
      "aicq.identity.info",
      "aicq.agent.create",
      "aicq.agent.delete",
      "aicq.chat.send",
      "aicq.chat.history",
      "aicq.chat.delete",
      "aicq.chat.streamChunk",
      "aicq.chat.streamEnd",
      "aicq.groups.list",
      "aicq.groups.create",
      "aicq.groups.join",
      "aicq.groups.messages",
      "aicq.groups.silent",
      "aicq.sessions.list",
    ],
  }),

  // ── DM Security ──────────────────────────────────────────────────
  security: {
    dm: {
      channelKey: "aicq-chat",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  // ── Pairing ──────────────────────────────────────────────────────
  pairing: {
    text: {
      idLabel: "AICQ Friend Code",
      message: "Share this pairing code with the other party:",
      notify: async ({ target, code }) => {
        // AICQ pairing codes are shared out-of-band by the operator.
        // No automatic notification is sent to the peer.
      },
    },
  },

  // ── Threading ────────────────────────────────────────────────────
  threading: {
    topLevelReplyToMode: "reply",
  },

  // ── Outbound ─────────────────────────────────────────────────────
  outbound: {
    attachedResults: {
      channel: "aicq-chat",

      sendText: async (params) => {
        if (!runtime.chat) {
          throw new Error("AICQ runtime not initialized — cannot send text");
        }
        const fromId =
          params.from ||
          params.accountId ||
          (runtime.identity && runtime.identity.listAgents()[0]?.agent_id);
        const result = await runtime.chat.sendMessage(
          fromId,
          params.to,
          params.text,
          { isGroup: false }
        );
        return { messageId: result?.message_id || result?.id || "sent" };
      },
    },

    base: {
      sendMedia: async (params) => {
        if (!runtime.chat) {
          throw new Error("AICQ runtime not initialized — cannot send media");
        }
        const fromId =
          params.from ||
          params.accountId ||
          (runtime.identity && runtime.identity.listAgents()[0]?.agent_id);
        await runtime.chat.sendMessage(
          fromId,
          params.to,
          params.mediaUrl || params.filePath,
          { type: params.mediaType || "file", isGroup: false }
        );
      },
    },
  },
});

// ── Add config helpers (required by OpenClaw channel loader) ──────────
// createChatChannelPlugin does not auto-attach config helpers,
// but the OpenClaw loader requires plugin.config.listAccountIds
// and plugin.config.resolveAccount for channel registration.
_plugin.config = {
  /**
   * List all account IDs configured for this channel.
   */
  listAccountIds(cfg) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    if (section.accountId) {
      return [section.accountId];
    }
    return [];
  },

  /**
   * Resolve an account from config. Reuses the setup resolver.
   */
  resolveAccount,

  /**
   * Lightweight account inspection.
   */
  inspectAccount,

  /**
   * Check if the channel is configured.
   */
  isConfigured(cfg) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    return Boolean(section.accountId);
  },

  /**
   * Return the reason the channel is not configured.
   */
  unconfiguredReason(cfg) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    if (!section.accountId) {
      return "accountId is required — set channels.aicq-chat.accountId in openclaw.json";
    }
    return null;
  },

  /**
   * Describe the account for status surfaces.
   */
  describeAccount(cfg, accountId) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    return {
      accountId: accountId || section.accountId || null,
      label: "AICQ Encrypted Chat",
      enabled: section.enabled !== false,
    };
  },
};

export const aicqChatPlugin = _plugin;
