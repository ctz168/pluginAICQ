/**
 * AICQ Channel Plugin — Gateway HTTP Routes
 *
 * Provides HTTP route handlers for the OpenClaw Gateway.
 * These routes serve the SPA UI and REST API endpoints.
 *
 * Routes are served via Gateway HTTP, not an independent Express server.
 * Prefix: /plugins/aicq-chat/
 */
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

/**
 * Create UI route handlers
 * @param {Object} ctx - Plugin context with managers
 */
function createUiRoutes(ctx) {
  const { db, identity, serverClient, handshake, chat, dataDir } = ctx;
  const UPLOADS_DIR = path.join(dataDir, 'uploads');

  // Ensure uploads directory exists
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  /**
   * Helper to get current agent ID
   */
  function getAgentId(req) {
    return req.query?.agent_id || req.body?.agent_id || (identity.listAgents()[0]?.agent_id);
  }

  /**
   * Register all routes on an Express app or router
   * This is called by the Gateway to mount the routes
   */
  function registerRoutes(app) {
    // ── Serve SPA static files ────────────────────────────────────
    const publicDir = path.join(__dirname, '..', 'public');
    app.use('/plugins/aicq-chat/ui', (req, res, next) => {
      // Serve static files from public/
      const filePath = path.join(publicDir, req.path === '/' ? 'index.html' : req.path);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.sendFile(filePath);
      } else {
        // SPA fallback: serve index.html for all unknown routes
        res.sendFile(path.join(publicDir, 'index.html'));
      }
    });

    // ── API Routes ────────────────────────────────────────────────

    // Status
    app.get('/plugins/aicq-chat/api/status', (req, res) => {
      res.json({
        status: 'running',
        version: '3.0.0',
        architecture: 'channel',
        connected: serverClient.connected,
        serverUrl: ctx.serverUrl,
      });
    });

    // Agents
    app.get('/plugins/aicq-chat/api/agents', (req, res) => {
      res.json({ agents: identity.listAgents() });
    });

    app.post('/plugins/aicq-chat/api/agents', async (req, res) => {
      try {
        const { agent_id, nickname } = req.body;
        if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
        const agent = identity.createAgent(agent_id, nickname);
        try {
          await serverClient.start(agent_id);
        } catch (e) {
          console.error('[AICQ] Server registration failed:', e.message);
        }
        res.json({ success: true, agent });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.delete('/plugins/aicq-chat/api/agents/:id', (req, res) => {
      identity.deleteAgent(req.params.id);
      res.json({ success: true });
    });

    // Friends
    app.get('/plugins/aicq-chat/api/friends', (req, res) => {
      const agentId = getAgentId(req);
      res.json({ friends: db.listFriends(agentId) });
    });

    app.post('/plugins/aicq-chat/api/friends/add', async (req, res) => {
      try {
        const { temp_number, friend_code, agent_id } = req.body;
        const agentId = agent_id || getAgentId(req);
        const code = temp_number || friend_code;
        if (!code) return res.status(400).json({ error: 'temp_number or friend_code is required' });
        const result = await handshake.addFriendByCode(agentId, code);
        res.json({ success: true, result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.delete('/plugins/aicq-chat/api/friends/:id', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        db.removeFriend(agentId, req.params.id);
        try { await serverClient.removeFriend(req.params.id); } catch (e) {}
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/plugins/aicq-chat/api/friends/requests', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        let serverRequests = [];
        try {
          await serverClient.ensureAuth(agentId);
          const result = await serverClient.listFriendRequests();
          serverRequests = result.sent || [];
          serverRequests = serverRequests.concat(result.received || []);
        } catch (e) {}
        const localRequests = db.getPendingRequests(agentId);
        res.json({ requests: [...localRequests, ...serverRequests] });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/plugins/aicq-chat/api/friends/requests/:id/accept', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        const result = await handshake.acceptRequest(agentId, req.params.id);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/plugins/aicq-chat/api/friends/requests/:id/reject', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        const result = await handshake.rejectRequest(agentId, req.params.id);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Groups
    app.get('/plugins/aicq-chat/api/groups', (req, res) => {
      const agentId = getAgentId(req);
      res.json({ groups: db.listGroups(agentId) });
    });

    app.post('/plugins/aicq-chat/api/groups', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });
        await serverClient.ensureAuth(agentId);
        const result = await serverClient.createGroup(name, description);
        if (result.id) {
          db.addGroup({
            agent_id: agentId,
            id: result.id,
            name,
            owner_id: agentId,
            members_json: result.members || '[]',
            description: description || '',
          });
        }
        res.json({ success: true, group: result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/plugins/aicq-chat/api/groups/:id/join', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        await serverClient.ensureAuth(agentId);
        const result = await serverClient.inviteGroupMember(req.params.id, agentId);
        res.json({ success: true, result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/plugins/aicq-chat/api/groups/:id/messages', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        const limit = parseInt(req.query.limit || '50', 10);
        const before = req.query.before || null;
        try {
          await serverClient.ensureAuth(agentId);
          const result = await serverClient.getGroupMessages(req.params.id, limit, before);
          if (result.messages && result.messages.length > 0) {
            return res.json({ messages: result.messages });
          }
        } catch (e) {}
        const messages = db.getChatHistory(agentId, req.params.id, { limit, before });
        res.json({ messages });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.put('/plugins/aicq-chat/api/groups/:id/silent', (req, res) => {
      const agentId = getAgentId(req);
      const { silent } = req.body;
      db.setGroupSilentMode(agentId, req.params.id, !!silent);
      res.json({ success: true, silent: !!silent });
    });

    // Chat
    app.get('/plugins/aicq-chat/api/chat/:targetId', (req, res) => {
      const agentId = getAgentId(req);
      const limit = parseInt(req.query.limit || '50', 10);
      const before = req.query.before || null;
      const messages = db.getChatHistory(agentId, req.params.targetId, { limit, before });
      res.json({ messages });
    });

    app.post('/plugins/aicq-chat/api/chat/send', async (req, res) => {
      try {
        const { agent_id, targetId, content, type, isGroup, mentions, file_url, file_name } = req.body;
        const agentId = agent_id || getAgentId(req);
        if (!targetId || !content) return res.status(400).json({ error: 'targetId and content are required' });
        const msg = await chat.sendMessage(agentId, targetId, content, {
          type: type || 'text',
          isGroup: !!isGroup,
          mentions: mentions || [],
          file_url,
          file_name,
        });
        res.json({ success: true, message: msg });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.delete('/plugins/aicq-chat/api/chat/:messageId', (req, res) => {
      const agentId = getAgentId(req);
      db.deleteMessage(agentId, req.params.messageId);
      res.json({ success: true });
    });

    // Streaming endpoints
    app.post('/plugins/aicq-chat/api/chat/stream-chunk', (req, res) => {
      try {
        const { targetId, friend_id, chunk_type, chunkType, data } = req.body;
        const streamTarget = targetId || friend_id;
        if (!streamTarget) return res.status(400).json({ error: 'targetId or friend_id is required' });
        if (!data) return res.status(400).json({ error: 'data is required' });
        const type = chunk_type || chunkType || 'text';
        const ALLOWED_CHUNK_TYPES = ['text', 'reasoning', 'thinking', 'clear_text', 'tool_call', 'tool_result'];
        if (!ALLOWED_CHUNK_TYPES.includes(type)) {
          return res.status(400).json({ error: `Invalid chunk_type: ${type}. Allowed: ${ALLOWED_CHUNK_TYPES.join(', ')}` });
        }
        const sent = serverClient.sendWS({
          type: 'stream_chunk',
          to: streamTarget,
          chunkType: type,
          data: data,
        });
        if (!sent) return res.status(503).json({ error: 'Not connected to server', success: false });
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/plugins/aicq-chat/api/chat/stream-end', (req, res) => {
      try {
        const { targetId, friend_id, message_id, messageId } = req.body;
        const streamTarget = targetId || friend_id;
        if (!streamTarget) return res.status(400).json({ error: 'targetId or friend_id is required' });
        const msgId = message_id || messageId || ('msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));
        const sent = serverClient.sendWS({
          type: 'stream_end',
          to: streamTarget,
          messageId: msgId,
        });
        if (!sent) return res.status(503).json({ error: 'Not connected to server', success: false });
        res.json({ success: true, messageId: msgId });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // File upload
    const multer = require('multer');
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    });

    app.post('/plugins/aicq-chat/api/upload', upload.single('file'), async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const agentId = getAgentId(req);
        const targetId = req.body.targetId;
        const isGroup = req.body.isGroup === 'true' || req.body.isGroup === '1';
        const msg = await chat.handleFileUpload(agentId, targetId, req.file, isGroup);
        res.json({ success: true, message: msg });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/plugins/aicq-chat/api/files/:fileId', (req, res) => {
      const filePath = path.join(UPLOADS_DIR, req.params.fileId);
      if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
      } else {
        res.status(404).json({ error: 'File not found' });
      }
    });

    // Identity
    app.get('/plugins/aicq-chat/api/identity', (req, res) => {
      const agentId = getAgentId(req);
      res.json(identity.getInfo(agentId) || {});
    });

    app.post('/plugins/aicq-chat/api/identity/nickname', (req, res) => {
      const { agent_id, nickname } = req.body;
      const agentId = agent_id || getAgentId(req);
      identity.updateNickname(agentId, nickname);
      res.json({ success: true });
    });

    app.post('/plugins/aicq-chat/api/identity/friend-code', async (req, res) => {
      try {
        const agentId = req.body.agent_id || getAgentId(req);
        await serverClient.ensureAuth(agentId);
        const result = await handshake.generateFriendCode(agentId);
        res.json({ success: true, code: result.number, expires_at: result.expiresAt || result.expires_at });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/plugins/aicq-chat/api/identity/qr', async (req, res) => {
      try {
        const agentId = getAgentId(req);
        const info = identity.getInfo(agentId);
        if (!info) return res.status(404).json({ error: 'Agent not found' });
        const qrData = JSON.stringify({
          type: 'aicq-friend',
          agent_id: info.agent_id,
          public_key: info.signing_public_key,
          exchange_public_key: info.exchange_public_key,
          fingerprint: info.fingerprint,
        });
        const qrImage = await QRCode.toDataURL(qrData);
        res.json({ qr: qrImage, data: qrData, info });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/plugins/aicq-chat/api/identity/rotate-keys', (req, res) => {
      try {
        const agentId = req.body.agent_id || getAgentId(req);
        identity.rotateKeys(agentId);
        res.json({ success: true, info: identity.getInfo(agentId) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/plugins/aicq-chat/api/identity/keys', (req, res) => {
      const agentId = getAgentId(req);
      const info = identity.loadAgent(agentId);
      if (!info) return res.status(404).json({ error: 'Agent not found' });
      res.json({
        agent_id: info.agent_id,
        nickname: info.nickname,
        signing_public_key: info.signing_public_key,
        exchange_public_key: info.exchange_public_key,
        signing_secret_key: info.signing_secret_key,
        exchange_secret_key: info.exchange_secret_key,
        fingerprint: info.fingerprint,
      });
    });

    // Sync endpoint
    app.post('/plugins/aicq-chat/api/sync', async (req, res) => {
      try {
        const agentId = req.body.agent_id || getAgentId(req);
        await serverClient.ensureAuth(agentId);
        // Sync friends
        const friendResult = await serverClient.listFriends();
        if (friendResult.friends) {
          for (const f of friendResult.friends) {
            const existing = db.getFriend(agentId, f.id);
            if (!existing) {
              db.addFriend({
                agent_id: agentId,
                id: f.id,
                public_key: f.public_key || f.publicKey || '',
                fingerprint: f.fingerprint || '',
                friend_type: f.type || f.friend_type || 'ai',
                ai_name: f.agent_name || f.ai_name || f.displayName || '',
              });
            } else {
              db.updateFriendOnline(agentId, f.id, f.is_online || f.isOnline || false);
            }
          }
        }
        // Sync groups
        const groupResult = await serverClient.listGroups();
        if (groupResult.groups) {
          for (const g of groupResult.groups) {
            db.addGroup({
              agent_id: agentId,
              id: g.id,
              name: g.name,
              owner_id: g.owner_id || g.ownerId || '',
              members_json: g.members || g.members_json || '[]',
              description: g.description || '',
            });
          }
        }
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Gateway proxy endpoint (for backward compatibility)
    app.post('/plugins/aicq-chat/api/gateway', async (req, res) => {
      try {
        const { method, kwargs } = req.body;
        if (!method) return res.status(400).json({ error: 'method is required' });
        // Import handleGateway from index.js
        const { handleGateway } = require('../index');
        const result = await handleGateway(method, kwargs);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  return {
    registerRoutes,
    // Also export as a map of route handlers for Gateway HTTP registration
    routes: {
      'GET /plugins/aicq-chat/ui/*': 'static:public',
      'GET /plugins/aicq-chat/api/status': 'api:status',
      'GET /plugins/aicq-chat/api/friends': 'api:friends.list',
      'POST /plugins/aicq-chat/api/friends/add': 'api:friends.add',
      'DELETE /plugins/aicq-chat/api/friends/:id': 'api:friends.remove',
      'GET /plugins/aicq-chat/api/messages': 'api:messages',
      'POST /plugins/aicq-chat/api/chat/send': 'api:chat.send',
    },
  };
}

module.exports = { createUiRoutes };
