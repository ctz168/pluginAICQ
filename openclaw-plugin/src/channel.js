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

// ── Template variable resolver ───────────────────────────────────────
// OpenClaw stores accountId as-is (e.g. "{{agent.id}}") in config.
// Plugins must resolve template variables at runtime.

function resolveTemplateVar(cfg, value) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\{\{(\w[\w.]*)\}\}$/);
  if (!match) return value;

  const path = match[1]; // e.g. "agent.id"
  if (path === "agent.id") {
    const agents = cfg.agents?.list || [];
    if (agents.length > 0) return agents[0].id;
    // Fallback: use the default agent ID from config
    return cfg.agents?.defaultId || "default";
  }

  return value; // unknown template — return as-is
}

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
  const rawAccountId = accountId || section.accountId || null;

  if (!rawAccountId) {
    throw new Error(
      "aicq-chat: accountId is required (set channels.aicq-chat.accountId)"
    );
  }

  // Resolve template variables like {{agent.id}}
  const resolvedAccountId = resolveTemplateVar(cfg, rawAccountId);

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

// ── Gateway adapter: startAccount / stopAccount ───────────────────────
// OpenClaw calls startAccount when the channel is activated (on startup
// or when re-enabled).  This is where we initialise the runtime, connect
// to the AICQ signalling server, and wire up inbound message delivery
// via the channelRuntime helpers.

_plugin.gateway = {
  /**
   * Start the channel account — connect to the AICQ server and begin
   * listening for inbound messages.
   */
  async startAccount(ctx) {
    const { cfg, accountId, account, setStatus } = ctx;

    console.log(`[AICQ Channel] startAccount called for ${accountId}`);

    // Ensure the runtime (DB, identity, transport) is initialised
    if (runtime.handleGateway) {
      // Runtime already initialised via registerFull — just verify
    }

    // Resolve the agent ID from OpenClaw config
    const agents = cfg.agents?.list || [];
    const agentId = agents.length > 0 ? agents[0].id : accountId;

    // Ensure we have an identity in the plugin DB
    if (runtime.identity) {
      const existing = runtime.identity.listAgents();
      if (existing.length === 0) {
        runtime.identity.createAgent(agentId, agents[0]?.name || "AICQ Agent");
        console.log(`[AICQ Channel] Created agent identity: ${agentId}`);
      }
    }

    // Connect to the AICQ server
    if (runtime.serverClient) {
      try {
        await runtime.serverClient.ensureAuth(agentId);
        console.log(`[AICQ Channel] Authenticated as ${agentId}`);

        // Connect WebSocket for real-time messages
        if (typeof runtime.serverClient.connect === "function") {
          await runtime.serverClient.connect(agentId);
          console.log("[AICQ Channel] WebSocket connected");
        }

        // Sync friends and groups from server
        if (runtime.handleGateway) {
          try {
            await runtime.handleGateway("aicq.friends.list", {});
            await runtime.handleGateway("aicq.groups.list", {});
          } catch (e) {
            console.warn("[AICQ Channel] Initial sync failed:", e.message);
          }
        }
      } catch (e) {
        console.error("[AICQ Channel] Failed to connect:", e.message);
      }
    }

    // Wire up inbound message handling via channelRuntime if available
    if (ctx.channelRuntime) {
      const { reply, routing } = ctx.channelRuntime;
      if (reply && routing) {
        console.log("[AICQ Channel] channelRuntime available — AI dispatch enabled");

        // Register inbound message handler on the serverClient
        if (runtime.serverClient && typeof runtime.serverClient.onMessage === "function") {
          runtime.serverClient.onMessage(async (msg) => {
            try {
              const resolvedAgentId = agents.length > 0 ? agents[0].id : accountId;
              const routeResult = await routing.resolveAgentRoute({
                channelId: "aicq-chat",
                accountId,
                fromId: msg.from || msg.sender_id,
                chatType: msg.isGroup ? "group" : "dm",
              });

              if (routeResult?.agentId) {
                await reply.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: {
                    channelId: "aicq-chat",
                    accountId,
                    fromId: msg.from || msg.sender_id,
                    text: msg.content || msg.text || "",
                    chatType: msg.isGroup ? "group" : "dm",
                  },
                  cfg,
                  dispatcherOptions: {
                    deliver: async (payload) => {
                      // Send AI reply back through AICQ
                      if (runtime.chat && payload.text) {
                        await runtime.chat.sendMessage(
                          resolvedAgentId,
                          msg.from || msg.sender_id,
                          payload.text,
                          { isGroup: !!msg.isGroup }
                        );
                      }
                    },
                  },
                });
              }
            } catch (e) {
              console.error("[AICQ Channel] Inbound message handling error:", e.message);
            }
          });
        }
      }
    } else {
      console.log("[AICQ Channel] channelRuntime not available — running in standalone mode");
    }

    // Update health status
    setStatus({
      accountId,
      enabled: true,
      configured: true,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    });

    console.log(`[AICQ Channel] Account ${accountId} started successfully`);
  },

  /**
   * Stop the channel account — disconnect and clean up.
   */
  async stopAccount(ctx) {
    const { accountId } = ctx;
    console.log(`[AICQ Channel] stopAccount called for ${accountId}`);

    if (runtime.serverClient && typeof runtime.serverClient.disconnect === "function") {
      try {
        runtime.serverClient.disconnect();
        console.log("[AICQ Channel] WebSocket disconnected");
      } catch (e) {
        console.warn("[AICQ Channel] Disconnect error:", e.message);
      }
    }
  },
};

// ── Add config helpers (required by OpenClaw channel loader) ──────────
// createChatChannelPlugin does not auto-attach config helpers,
// but the OpenClaw loader requires plugin.config.listAccountIds
// and plugin.config.resolveAccount for channel registration.

// resolveTemplateVar is defined at the top of this file.

_plugin.config = {
  /**
   * List all account IDs configured for this channel.
   * Resolves template variables like {{agent.id}}.
   */
  listAccountIds(cfg) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    if (section.accountId) {
      const resolved = resolveTemplateVar(cfg, section.accountId);
      return [resolved];
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
   * Default account ID for this channel.
   * Resolves {{agent.id}} to the actual agent ID.
   */
  defaultAccountId(cfg) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    if (section.accountId) {
      return resolveTemplateVar(cfg, section.accountId);
    }
    return "default";
  },

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
    const rawId = accountId || section.accountId || null;
    return {
      accountId: rawId ? resolveTemplateVar(cfg, rawId) : null,
      label: "AICQ Encrypted Chat",
      enabled: section.enabled !== false,
    };
  },
};

export const aicqChatPlugin = _plugin;
