/**
 * AICQ Chat Plugin — Channel Plugin Entry Point
 *
 * Architecture: Channel (in-process, no independent port)
 * - Runs inside the OpenClaw process
 * - Uses createChatChannelPlugin for E2EE chat channel
 * - Provides Gateway HTTP routes for the SPA UI
 * - No sidecar process needed
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Configuration ──────────────────────────────────────────────────
const DATA_DIR = process.env.AICQ_DATA_DIR || path.join(os.homedir(), '.aicq-plugin');
const SERVER_URL = process.env.AICQ_SERVER_URL || 'https://aicq.online';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Lazy-loaded modules (require db init) ──────────────────────────
let _db = null;
let _identity = null;
let _serverClient = null;
let _handshake = null;
let _chat = null;
let _channel = null;
let _uiRoutes = null;
let _initialized = false;

/**
 * Initialize all plugin components (async, called once)
 */
async function ensureInitialized() {
  if (_initialized) return;

  const PluginDatabase = require('./lib/database');
  const IdentityManager = require('./lib/identity');
  const ServerClient = require('./lib/server-client');
  const HandshakeManager = require('./lib/handshake');
  const ChatManager = require('./lib/chat');

  // Initialize database
  _db = new PluginDatabase(DATA_DIR);
  await _db.init();
  console.log('[AICQ Channel] Database initialized');

  // Initialize managers
  _identity = new IdentityManager(_db);
  _serverClient = new ServerClient(_identity, _db, SERVER_URL);
  _handshake = new HandshakeManager(_identity, _serverClient, _db);
  _chat = new ChatManager(_identity, _serverClient, _db, path.join(DATA_DIR, 'uploads'));

  // Load channel and UI route creators
  const { createAicqChannel } = require('./src/channel');
  const { createUiRoutes } = require('./src/ui-routes');

  _channel = createAicqChannel({
    db: _db,
    identity: _identity,
    serverClient: _serverClient,
    handshake: _handshake,
    chat: _chat,
    dataDir: DATA_DIR,
    serverUrl: SERVER_URL,
  });

  _uiRoutes = createUiRoutes({
    db: _db,
    identity: _identity,
    serverClient: _serverClient,
    handshake: _handshake,
    chat: _chat,
    dataDir: DATA_DIR,
  });

  // Periodic cleanup
  setInterval(() => _db.cleanup(), 3600000);

  _initialized = true;
  console.log('[AICQ Channel] Plugin components initialized');
}

// ── register() — Called by OpenClaw when the plugin is discovered ────
function register() {
  return {
    id: 'aicq-chat',
    name: 'AICQ Encrypted Chat',
    version: '3.0.0',
    description: 'End-to-end encrypted chat channel plugin for OpenClaw agents',
    kind: 'channel',

    // Channel configuration
    channel: {
      id: 'aicq-chat',
      label: 'AICQ Encrypted Chat',
    },

    // Tool definitions for OpenClaw agent use
    tools: {
      'chat-friend': {
        description: 'Manage AICQ friends — list, add by friend code, remove, view requests, accept/reject requests',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'remove', 'requests', 'accept', 'reject'],
              description: 'The friend management action to perform',
            },
            friend_code: {
              type: 'string',
              description: 'Friend code or temp number for adding a friend',
            },
            friend_id: {
              type: 'string',
              description: 'Friend ID for remove/accept/reject actions',
            },
          },
          required: ['action'],
        },
      },
      'chat-send': {
        description: 'Send an encrypted message to a friend or group via AICQ',
        parameters: {
          type: 'object',
          properties: {
            targetId: {
              type: 'string',
              description: 'The friend ID or group ID to send the message to',
            },
            content: {
              type: 'string',
              description: 'The message content to send',
            },
            isGroup: {
              type: 'boolean',
              description: 'Whether the target is a group (default: false)',
            },
          },
          required: ['targetId', 'content'],
        },
      },
      'chat-export-key': {
        description: 'Export your AICQ identity public key and fingerprint for sharing',
        parameters: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['json', 'qr'],
              description: 'Output format: json for key data, qr for QR code image (default: json)',
            },
          },
        },
      },
    },
  };
}

// ── activate() — Called by OpenClaw when the plugin is enabled ───────
async function activate(config) {
  await ensureInitialized();

  // Auto-create default agent if none exists
  const agents = _identity.listAgents();
  let currentAgentId;
  if (agents.length === 0) {
    const defaultAgent = _identity.createAgent('agent-' + Date.now(), '默认Agent');
    currentAgentId = defaultAgent.agent_id;
    console.log('[AICQ Channel] Created default agent:', currentAgentId);
  } else {
    currentAgentId = agents[0].agent_id;
  }

  // Connect to AICQ server
  try {
    await _serverClient.start(currentAgentId);
    // Sync friends and groups from server
    await syncFriendsFromServer(currentAgentId);
    await syncGroupsFromServer(currentAgentId);
  } catch (e) {
    console.error('[AICQ Channel] Initial server connection failed:', e.message);
  }

  return {
    handleTool,
    handleGateway,
    channel: _channel,
    gatewayRoutes: _uiRoutes,
  };
}

// ── Sync helpers ────────────────────────────────────────────────────
async function syncFriendsFromServer(agentId) {
  try {
    await _serverClient.ensureAuth(agentId);
    const result = await _serverClient.listFriends();
    if (result.friends) {
      for (const f of result.friends) {
        const existing = _db.getFriend(agentId, f.id);
        if (!existing) {
          _db.addFriend({
            agent_id: agentId,
            id: f.id,
            public_key: f.public_key || f.publicKey || '',
            fingerprint: f.fingerprint || '',
            friend_type: f.type || f.friend_type || 'ai',
            ai_name: f.agent_name || f.ai_name || f.displayName || '',
          });
        } else {
          _db.updateFriendOnline(agentId, f.id, f.is_online || f.isOnline || false);
        }
      }
    }
  } catch (e) {
    console.error('[AICQ Channel] Sync friends failed:', e.message);
  }
}

async function syncGroupsFromServer(agentId) {
  try {
    await _serverClient.ensureAuth(agentId);
    const result = await _serverClient.listGroups();
    if (result.groups) {
      for (const g of result.groups) {
        _db.addGroup({
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
    console.error('[AICQ Channel] Sync groups failed:', e.message);
  }
}

// ── Tool handler ────────────────────────────────────────────────────
async function handleTool(toolName, params) {
  await ensureInitialized();
  const agents = _identity.listAgents();
  const currentAgentId = agents.length > 0 ? agents[0].agent_id : null;

  switch (toolName) {
    case 'chat-friend': {
      const { action, friend_code, friend_id } = params || {};
      switch (action) {
        case 'list':
          return { friends: _db.listFriends(currentAgentId) };
        case 'add':
          return await _handshake.addFriendByCode(currentAgentId, friend_code);
        case 'remove':
          _db.removeFriend(currentAgentId, friend_id);
          try { await _serverClient.removeFriend(friend_id); } catch (e) {}
          return { success: true };
        case 'requests':
          return { requests: _db.getPendingRequests(currentAgentId) };
        case 'accept':
          return await _handshake.acceptRequest(currentAgentId, friend_id);
        case 'reject':
          return await _handshake.rejectRequest(currentAgentId, friend_id);
        default:
          return { error: `Unknown friend action: ${action}` };
      }
    }
    case 'chat-send':
      return await _chat.sendMessage(
        currentAgentId,
        params.targetId,
        params.content,
        { isGroup: params.isGroup || false }
      );
    case 'chat-export-key':
      return _identity.getInfo(currentAgentId) || {};
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Gateway handler ─────────────────────────────────────────────────
async function handleGateway(method, kwargs = {}) {
  await ensureInitialized();
  const agents = _identity.listAgents();
  const currentAgentId = agents.length > 0 ? agents[0].agent_id : null;

  switch (method) {
    case 'aicq.status':
      return {
        state: _serverClient.connected ? 'connected' : 'disconnected',
        agent_id: currentAgentId,
        version: '3.0.0',
        architecture: 'channel',
      };
    case 'aicq.friends.list':
      return { friends: _db.listFriends(currentAgentId) };
    case 'aicq.friends.add':
      return await _handshake.addFriendByCode(currentAgentId, kwargs.temp_number);
    case 'aicq.friends.remove':
      _db.removeFriend(currentAgentId, kwargs.friend_id);
      return { success: true };
    case 'aicq.friends.requests':
      return { requests: _db.getPendingRequests(currentAgentId) };
    case 'aicq.friends.acceptRequest':
      return await _handshake.acceptRequest(currentAgentId, kwargs.request_id);
    case 'aicq.friends.rejectRequest':
      return await _handshake.rejectRequest(currentAgentId, kwargs.request_id);
    case 'aicq.identity.info':
      return _identity.getInfo(currentAgentId) || {};
    case 'aicq.agent.create':
      _identity.createAgent(kwargs.agent_id, kwargs.nickname);
      return { success: true };
    case 'aicq.agent.delete':
      _identity.deleteAgent(kwargs.agent_id);
      return { success: true };
    case 'aicq.chat.send':
      return await _chat.sendMessage(currentAgentId, kwargs.targetId, kwargs.content, { isGroup: kwargs.isGroup });
    case 'aicq.chat.history':
      return { messages: _db.getChatHistory(currentAgentId, kwargs.targetId, { limit: kwargs.limit || 50 }) };
    case 'aicq.chat.delete':
      _db.deleteMessage(currentAgentId, kwargs.message_id);
      return { success: true };
    case 'aicq.chat.streamChunk': {
      if (!kwargs.friend_id && !kwargs.targetId) return { error: 'friend_id or targetId is required' };
      if (!kwargs.data) return { error: 'data is required' };
      const chunkType = kwargs.chunk_type || kwargs.chunkType || 'text';
      const ALLOWED_CHUNK_TYPES = ['text', 'reasoning', 'thinking', 'clear_text', 'tool_call', 'tool_result'];
      if (!ALLOWED_CHUNK_TYPES.includes(chunkType)) return { error: `Invalid chunk_type: ${chunkType}. Allowed: ${ALLOWED_CHUNK_TYPES.join(', ')}` };
      const streamTarget = kwargs.friend_id || kwargs.targetId;
      const sent = _serverClient.sendWS({
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
      const endSent = _serverClient.sendWS({
        type: 'stream_end',
        to: endTarget,
        messageId: msgId,
      });
      if (!endSent) return { error: 'Not connected to server', success: false };
      return { success: true, messageId: msgId };
    }
    case 'aicq.groups.list':
      return { groups: _db.listGroups(currentAgentId) };
    case 'aicq.groups.create': {
      await _serverClient.ensureAuth(currentAgentId);
      const result = await _serverClient.createGroup(kwargs.name, kwargs.description);
      if (result.id) {
        _db.addGroup({
          agent_id: currentAgentId,
          id: result.id,
          name: kwargs.name,
          owner_id: currentAgentId,
          members_json: result.members || '[]',
          description: kwargs.description || '',
        });
      }
      return { success: true, group: result };
    }
    case 'aicq.groups.join':
      await _serverClient.ensureAuth(currentAgentId);
      return await _serverClient.inviteGroupMember(kwargs.group_id, currentAgentId);
    case 'aicq.groups.messages': {
      await _serverClient.ensureAuth(currentAgentId);
      return await _serverClient.getGroupMessages(kwargs.group_id, kwargs.limit || 50);
    }
    case 'aicq.groups.silent':
      _db.setGroupSilentMode(currentAgentId, kwargs.group_id, !!kwargs.silent);
      return { success: true, silent: !!kwargs.silent };
    case 'aicq.sessions.list':
      return { sessions: [] };
    default:
      return { error: `Unknown method: ${method}` };
  }
}

// ── Exports ─────────────────────────────────────────────────────────
module.exports = {
  register,
  activate,
  handleTool,
  handleGateway,
  ensureInitialized,
};
