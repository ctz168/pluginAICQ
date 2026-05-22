/**
 * AICQ Channel Plugin — Core Channel Logic
 *
 * Wraps existing lib/ modules (identity, server-client, handshake, chat, database)
 * into the OpenClaw Channel plugin interface via createChatChannelPlugin.
 *
 * Architecture: In-process Channel (no sidecar, no independent port)
 */
const { encryptMessage, decryptMessage, deriveSessionKey, computeFingerprint } = require('../lib/crypto');

/**
 * Create the AICQ channel plugin
 * @param {Object} ctx - Plugin context with managers and config
 */
function createAicqChannel(ctx) {
  const { db, identity, serverClient, handshake, chat, dataDir, serverUrl } = ctx;

  return {
    // ── Account Resolution ──
    resolveAccount: async (agentId) => {
      // Use OpenClaw agent ID directly as AICQ account ID
      let agentIdentity = identity.loadAgent(agentId);
      if (!agentIdentity) {
        agentIdentity = identity.createAgent(agentId, `agent-${agentId.slice(0, 8)}`);
      }
      return {
        accountId: agentId,
        displayName: agentIdentity.nickname || `agent-${agentId.slice(0, 8)}`,
        metadata: {
          publicKey: agentIdentity.signing_public_key,
          exchangePublicKey: agentIdentity.exchange_public_key,
          fingerprint: agentIdentity.fingerprint,
        },
      };
    },

    // ── DM Security Policy ──
    security: {
      dm: {
        allowFrom: async (accountId, peerId) => {
          // Only friends in the contact list can send DMs
          return db.isFriend ? db.isFriend(accountId, peerId) : !!db.getFriend(accountId, peerId);
        },
      },
    },

    // ── Friend Pairing ──
    pairing: {
      text: async (accountId) => {
        try {
          await serverClient.ensureAuth(accountId);
          const result = await handshake.generateFriendCode(accountId);
          const code = result.number;
          return {
            code,
            instructions: `Share this pairing code with the other party: ${code}. They can add you using the chat-friend tool's add action.`,
          };
        } catch (e) {
          // Fallback: use public key prefix as pairing code
          const info = identity.getInfo(accountId);
          const code = info ? info.exchange_public_key.slice(0, 16) : 'error';
          return {
            code,
            instructions: `Share this pairing code with the other party: ${code}`,
          };
        }
      },
      verify: async (accountId, peerCode) => {
        try {
          const result = await handshake.addFriendByCode(accountId, peerCode);
          return { success: true, peerId: result.peer_id || result.friend_id || peerCode };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
    },

    // ── Inbound Message Processing ──
    inbound: {
      onText: async (message) => {
        const { toAccountId, fromPeerId, encryptedContent } = message;

        // Try to decrypt if we have a session key
        let content = encryptedContent || message.content || message.payload || '';
        const session = db.loadSession(toAccountId, fromPeerId);
        if (session && session.session_key && typeof content === 'string') {
          try {
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
        const keys = identity.loadAgent(message.toAccountId);
        let content = message.encryptedContent || message.content || '';
        const session = db.loadSession(message.toAccountId, message.fromPeerId);
        if (session && session.session_key && typeof content === 'string') {
          try {
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

    // ── Outbound Message Processing ──
    outbound: {
      sendText: async (fromAccountId, toPeerId, text) => {
        const result = await chat.sendMessage(fromAccountId, toPeerId, text, { isGroup: false });
        return result;
      },
      sendMedia: async (fromAccountId, toPeerId, mediaUrl, mediaType) => {
        const result = await chat.sendMessage(fromAccountId, toPeerId, mediaUrl, {
          type: mediaType || 'file',
          isGroup: false,
        });
        return result;
      },
    },

    // ── Lifecycle ──
    lifecycle: {
      onAccountCreate: async (accountId) => {
        let agentIdentity = identity.loadAgent(accountId);
        if (!agentIdentity) {
          agentIdentity = identity.createAgent(accountId, `agent-${accountId.slice(0, 8)}`);
        }
        try {
          await serverClient.start(accountId);
        } catch (e) {
          console.error('[AICQ Channel] Server connection failed for account:', accountId, e.message);
        }
      },
      onAccountDelete: async (accountId) => {
        try {
          serverClient.disconnect();
        } catch (e) {}
        identity.deleteAgent(accountId);
      },
      onShutdown: async () => {
        try {
          serverClient.stop();
        } catch (e) {}
        console.log('[AICQ Channel] Shutdown complete');
      },
    },
  };
}

module.exports = { createAicqChannel };
