/**
 * AICQ Chat Plugin — Main Entry Point
 * OpenClaw sidecar plugin providing E2EE chat UI
 *
 * Uses sql.js (pure WASM SQLite) instead of better-sqlite3
 * to avoid native C++ compilation issues.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const PluginDatabase = require('./lib/database');

// ─── Configuration ──────────────────────────────────────────────────
const PORT = parseInt(process.env.AICQ_PORT || '6109', 10);
const SERVER_URL = process.env.AICQ_SERVER_URL || 'http://aicq.online:61018';
const DATA_DIR = process.env.AICQ_DATA_DIR || path.join(os.homedir(), '.aicq-plugin');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Async bootstrap ────────────────────────────────────────────────
// sql.js requires async init, so we wrap the entire app setup
(async () => {
  // Initialize database (async — loads WASM + opens/creates DB file)
  const db = new PluginDatabase(DATA_DIR);
  await db.init();
  console.log('[AICQ] Database initialized');

  // Lazy-load modules that depend on db
  const IdentityManager = require('./lib/identity');
  const ServerClient = require('./lib/server-client');
  const HandshakeManager = require('./lib/handshake');
  const ChatManager = require('./lib/chat');

  const identity = new IdentityManager(db);
  const serverClient = new ServerClient(identity, db, SERVER_URL);
  const handshake = new HandshakeManager(identity, serverClient, db);
  const chat = new ChatManager(identity, serverClient, db, UPLOADS_DIR);

  // Auto-create a default agent if none exists
  const agents = identity.listAgents();
  let currentAgentId = null;
  if (agents.length === 0) {
    const defaultAgent = identity.createAgent('agent-' + Date.now(), '默认Agent');
    currentAgentId = defaultAgent.agent_id;
    console.log('[AICQ] Created default agent:', currentAgentId);
  } else {
    currentAgentId = agents[0].agent_id;
  }

  // Connect to server in background
  (async () => {
    try {
      await serverClient.start(currentAgentId);
      await syncFriendsFromServer(currentAgentId);
      await syncGroupsFromServer(currentAgentId);
    } catch (e) {
      console.error('[AICQ] Initial server connection failed:', e.message);
    }
  })();

  // Periodic cleanup + save
  setInterval(() => db.cleanup(), 3600000);

  // ─── Helper: get current agent ID ──────────────────────────────────
  function getAgentId(req) {
    return req.query.agent_id || req.body?.agent_id || currentAgentId;
  }

  // ─── Sync friends/groups from server ────────────────────────────────
  async function syncFriendsFromServer(agentId) {
    try {
      await serverClient.ensureAuth(agentId);
      const result = await serverClient.listFriends();
      if (result.friends) {
        for (const f of result.friends) {
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
    } catch (e) {
      console.error('[AICQ] Sync friends failed:', e.message);
    }
  }

  async function syncGroupsFromServer(agentId) {
    try {
      await serverClient.ensureAuth(agentId);
      const result = await serverClient.listGroups();
      if (result.groups) {
        for (const g of result.groups) {
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
    } catch (e) {
      console.error('[AICQ] Sync groups failed:', e.message);
    }
  }

  // ─── Express App ────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  // ─── Serve SPA ──────────────────────────────────────────────────────
  app.use(express.static(path.join(__dirname, 'public')));

  // ─── API Routes ─────────────────────────────────────────────────────

  // Status
  app.get('/api/status', (req, res) => {
    res.json({
      status: 'running',
      version: '2.6.0',
      connected: serverClient.connected,
      currentAgent: currentAgentId,
      serverUrl: SERVER_URL,
    });
  });

  // Agents
  app.get('/api/agents', (req, res) => {
    res.json({ agents: identity.listAgents() });
  });

  app.post('/api/agents', async (req, res) => {
    try {
      const { agent_id, nickname } = req.body;
      if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
      const agent = identity.createAgent(agent_id, nickname);
      currentAgentId = agent_id;
      try {
        await serverClient.start(agent_id);
      } catch (e) {
        console.error('Server registration failed:', e.message);
      }
      res.json({ success: true, agent });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/agents/:id', (req, res) => {
    identity.deleteAgent(req.params.id);
    if (currentAgentId === req.params.id) {
      const remaining = identity.listAgents();
      currentAgentId = remaining.length > 0 ? remaining[0].agent_id : null;
    }
    res.json({ success: true });
  });

  app.post('/api/agents/switch', async (req, res) => {
    try {
      const { agent_id } = req.body;
      if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
      currentAgentId = agent_id;
      await serverClient.switchAgent(agent_id);
      await syncFriendsFromServer(agent_id);
      await syncGroupsFromServer(agent_id);
      res.json({ success: true, agent_id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Friends
  app.get('/api/friends', (req, res) => {
    const agentId = getAgentId(req);
    res.json({ friends: db.listFriends(agentId) });
  });

  app.post('/api/friends/add', async (req, res) => {
    try {
      const { temp_number, friend_code, agent_id } = req.body;
      const agentId = agent_id || currentAgentId;
      const code = temp_number || friend_code;
      if (!code) return res.status(400).json({ error: 'temp_number or friend_code is required' });
      const result = await handshake.addFriendByCode(agentId, code);
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/friends/:id', async (req, res) => {
    try {
      const agentId = getAgentId(req);
      db.removeFriend(agentId, req.params.id);
      try { await serverClient.removeFriend(req.params.id); } catch (e) {}
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/friends/requests', async (req, res) => {
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

  app.post('/api/friends/requests/:id/accept', async (req, res) => {
    try {
      const agentId = getAgentId(req);
      const result = await handshake.acceptRequest(agentId, req.params.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/friends/requests/:id/reject', async (req, res) => {
    try {
      const agentId = getAgentId(req);
      const result = await handshake.rejectRequest(agentId, req.params.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Groups
  app.get('/api/groups', (req, res) => {
    const agentId = getAgentId(req);
    res.json({ groups: db.listGroups(agentId) });
  });

  app.post('/api/groups', async (req, res) => {
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

  app.post('/api/groups/:id/join', async (req, res) => {
    try {
      const agentId = getAgentId(req);
      await serverClient.ensureAuth(agentId);
      const result = await serverClient.inviteGroupMember(req.params.id, agentId);
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/groups/:id/messages', async (req, res) => {
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

  app.put('/api/groups/:id/silent', (req, res) => {
    const agentId = getAgentId(req);
    const { silent } = req.body;
    db.setGroupSilentMode(agentId, req.params.id, !!silent);
    res.json({ success: true, silent: !!silent });
  });

  // Chat
  app.get('/api/chat/:targetId', (req, res) => {
    const agentId = getAgentId(req);
    const limit = parseInt(req.query.limit || '50', 10);
    const before = req.query.before || null;
    const messages = db.getChatHistory(agentId, req.params.targetId, { limit, before });
    res.json({ messages });
  });

  app.post('/api/chat/send', async (req, res) => {
    try {
      const { agent_id, targetId, content, type, isGroup, mentions, file_url, file_name } = req.body;
      const agentId = agent_id || currentAgentId;
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

  app.delete('/api/chat/:messageId', (req, res) => {
    const agentId = getAgentId(req);
    db.deleteMessage(agentId, req.params.messageId);
    res.json({ success: true });
  });

  // Streaming endpoints
  app.post('/api/chat/stream-chunk', (req, res) => {
    try {
      const { targetId, friend_id, chunk_type, chunkType, data } = req.body;
      const streamTarget = targetId || friend_id;
      if (!streamTarget) return res.status(400).json({ error: 'targetId or friend_id is required' });
      if (!data) return res.status(400).json({ error: 'data is required' });
      const type = chunk_type || chunkType || 'text';
      // Allowed chunk types — extended to include thinking and clear_text
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

  app.post('/api/chat/stream-end', (req, res) => {
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
  app.post('/api/upload', upload.single('file'), async (req, res) => {
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

  app.get('/api/files/:fileId', (req, res) => {
    const filePath = path.join(UPLOADS_DIR, req.params.fileId);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  });

  // Identity
  app.get('/api/identity', (req, res) => {
    const agentId = getAgentId(req);
    res.json(identity.getInfo(agentId) || {});
  });

  app.post('/api/identity/nickname', (req, res) => {
    const { agent_id, nickname } = req.body;
    const agentId = agent_id || currentAgentId;
    identity.updateNickname(agentId, nickname);
    res.json({ success: true });
  });

  app.post('/api/identity/friend-code', async (req, res) => {
    try {
      const agentId = req.body.agent_id || currentAgentId;
      await serverClient.ensureAuth(agentId);
      const result = await handshake.generateFriendCode(agentId);
      res.json({ success: true, code: result.number, expires_at: result.expiresAt || result.expires_at });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/identity/qr', async (req, res) => {
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

  app.post('/api/identity/rotate-keys', (req, res) => {
    try {
      const agentId = req.body.agent_id || currentAgentId;
      const newInfo = identity.rotateKeys(agentId);
      res.json({ success: true, info: identity.getInfo(agentId) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Avatar upload
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max (client should resize before uploading)
    fileFilter: (req, file, cb) => {
      if (file.mimetype && file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    },
  });

  app.post('/api/identity/avatar', avatarUpload.single('avatar'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const agentId = req.body.agent_id || currentAgentId;

      const avatarsDir = path.join(DATA_DIR, 'avatars');
      fs.mkdirSync(avatarsDir, { recursive: true });
      const ext = req.file.mimetype.split('/')[1] || 'png';
      const avatarId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const filename = `${avatarId}.${ext}`;
      const filePath = path.join(avatarsDir, filename);
      fs.writeFileSync(filePath, req.file.buffer);

      const avatarUrl = `/api/identity/avatars/${filename}`;
      identity.updateAvatar(agentId, avatarUrl);

      try {
        await serverClient.ensureAuth(agentId);
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('avatar', req.file.buffer, {
          filename: req.file.originalname || 'avatar.' + ext,
          contentType: req.file.mimetype,
        });
        const fetch = (await import('node-fetch')).default;
        const serverUrl = SERVER_URL + '/api/v1/accounts/avatar';
        const serverResp = await fetch(serverUrl, {
          method: 'POST',
          body: form,
          headers: {
            ...form.getHeaders(),
            'Authorization': 'Bearer ' + serverClient.getAccessToken(agentId),
          },
        });
        if (serverResp.ok) {
          const serverData = await serverResp.json();
          if (serverData.avatar) {
            identity.updateAvatar(agentId, serverData.avatar);
            return res.json({ success: true, avatar: serverData.avatar });
          }
        }
      } catch (e) {
        console.error('[AICQ] Server avatar upload failed:', e.message);
      }

      res.json({ success: true, avatar: avatarUrl });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/identity/avatars/:filename', (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(DATA_DIR, 'avatars', filename);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: 'Avatar not found' });
    }
  });

  app.get('/api/identity/keys', (req, res) => {
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
  app.post('/api/sync', async (req, res) => {
    try {
      const agentId = req.body.agent_id || currentAgentId;
      await syncFriendsFromServer(agentId);
      await syncGroupsFromServer(agentId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Gateway Proxy Endpoint (for extension.js) ──────────────────────
  app.post('/api/gateway', async (req, res) => {
    try {
      const { method, kwargs } = req.body;
      if (!method) return res.status(400).json({ error: 'method is required' });
      const result = await handleGatewayCall(method, kwargs);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Start Server ───────────────────────────────────────────────────
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AICQ Plugin] Running on http://0.0.0.0:${PORT}`);
    console.log(`[AICQ Plugin] Server: ${SERVER_URL}`);
    console.log(`[AICQ Plugin] Data dir: ${DATA_DIR}`);
  });

  // ─── OpenClaw Gateway Integration ───────────────────────────────────
  process.on('message', (msg) => {
    if (msg.type === 'gateway_call') {
      handleGatewayCall(msg.method, msg.kwargs).then(result => {
        process.send({ type: 'gateway_response', id: msg.id, result });
      }).catch(err => {
        process.send({ type: 'gateway_response', id: msg.id, error: err.message });
      });
    }
  });

  async function handleGatewayCall(method, kwargs = {}) {
    switch (method) {
      case 'aicq.status':
        return { state: serverClient.connected ? 'connected' : 'disconnected', agent_id: currentAgentId, version: '2.6.0' };
      case 'aicq.friends.list':
        return { friends: db.listFriends(currentAgentId) };
      case 'aicq.friends.add':
        return await handshake.addFriendByCode(currentAgentId, kwargs.temp_number);
      case 'aicq.friends.remove':
        db.removeFriend(currentAgentId, kwargs.friend_id);
        return { success: true };
      case 'aicq.friends.requests':
        return { requests: db.getPendingRequests(currentAgentId) };
      case 'aicq.identity.info':
        return identity.getInfo(currentAgentId) || {};
      case 'aicq.agent.create':
        identity.createAgent(kwargs.agent_id, kwargs.nickname);
        return { success: true };
      case 'aicq.chat.send':
        return await chat.sendMessage(currentAgentId, kwargs.targetId, kwargs.content, { isGroup: kwargs.isGroup });
      case 'aicq.chat.history':
        return { messages: db.getChatHistory(currentAgentId, kwargs.targetId, { limit: kwargs.limit || 50 }) };
      case 'aicq.chat.streamChunk': {
        if (!kwargs.friend_id && !kwargs.targetId) return { error: 'friend_id or targetId is required' };
        if (!kwargs.data) return { error: 'data is required' };
        const chunkType = kwargs.chunk_type || kwargs.chunkType || 'text';
        // Allowed chunk types — extended to include thinking and clear_text
        const ALLOWED_CHUNK_TYPES = ['text', 'reasoning', 'thinking', 'clear_text', 'tool_call', 'tool_result'];
        if (!ALLOWED_CHUNK_TYPES.includes(chunkType)) return { error: `Invalid chunk_type: ${chunkType}. Allowed: ${ALLOWED_CHUNK_TYPES.join(', ')}` };
        const streamTarget = kwargs.friend_id || kwargs.targetId;
        const sent = serverClient.sendWS({
          type: 'stream_chunk',
          to: streamTarget,
          chunkType: chunkType,
          data: kwargs.data,
        });
        if (!sent) return { error: 'Not connected to server', success: false };
        return { success: true };
      }
      case 'aicq.chat.streamEnd': {
        if (!kwargs.friend_id && !kwargs.targetId) return { error: 'friend_id or targetId is required' };
        const endTarget = kwargs.friend_id || kwargs.targetId;
        const msgId = kwargs.message_id || kwargs.messageId || ('msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));
        const endSent = serverClient.sendWS({
          type: 'stream_end',
          to: endTarget,
          messageId: msgId,
        });
        if (!endSent) return { error: 'Not connected to server', success: false };
        return { success: true, messageId: msgId };
      }
      default:
        return { error: `Unknown method: ${method}` };
    }
  }
})().catch(err => {
  console.error('[AICQ] Fatal startup error:', err);
  process.exit(1);
});
