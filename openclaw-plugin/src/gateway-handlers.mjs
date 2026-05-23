/**
 * AICQ Gateway Handlers — Gateway method implementations
 *
 * Handles all aicq.* gateway methods for the SPA UI.
 * Lazy-initializes the plugin components on first call.
 */

let _handlersInitialized = false;
let _db = null;
let _identity = null;
let _serverClient = null;
let _handshake = null;
let _chat = null;

async function ensureHandlersInitialized() {
  if (_handlersInitialized) return;

  try {
    const channelModule = await import('./channel.mjs');
    await channelModule.ensureInitialized();
    // Access the lazy-loaded managers through the module's exports
    _db = channelModule._db;
    _identity = channelModule._identity;
    _serverClient = channelModule._serverClient;
    _handshake = channelModule._handshake;
    _chat = channelModule._chat;
    _handlersInitialized = true;
  } catch (e) {
    console.error('[AICQ Gateway] Failed to initialize handlers:', e.message);
    throw e;
  }
}

function getCurrentAgentId() {
  if (!_identity) return null;
  const agents = _identity.listAgents();
  return agents.length > 0 ? agents[0].agent_id : null;
}

/**
 * Main gateway method dispatcher
 */
export async function handleGateway(method, kwargs = {}, ctx = {}) {
  await ensureHandlersInitialized();
  const currentAgentId = getCurrentAgentId();

  switch (method) {
    case 'aicq.status':
      return {
        state: _serverClient?.connected ? 'connected' : 'disconnected',
        agent_id: currentAgentId,
        version: '3.3.0',
        architecture: 'channel',
      };

    case 'aicq.friends.list':
      return { friends: _db?.listFriends(currentAgentId) || [] };

    case 'aicq.friends.add':
      return await _handshake?.addFriendByCode(currentAgentId, kwargs.temp_number);

    case 'aicq.friends.remove':
      _db?.removeFriend(currentAgentId, kwargs.friend_id);
      return { success: true };

    case 'aicq.friends.requests':
      return { requests: _db?.getPendingRequests(currentAgentId) || [] };

    case 'aicq.friends.acceptRequest':
      return await _handshake?.acceptRequest(currentAgentId, kwargs.request_id);

    case 'aicq.friends.rejectRequest':
      return await _handshake?.rejectRequest(currentAgentId, kwargs.request_id);

    case 'aicq.identity.info':
      return _identity?.getInfo(currentAgentId) || {};

    case 'aicq.agent.create':
      _identity?.createAgent(kwargs.agent_id, kwargs.nickname);
      return { success: true };

    case 'aicq.agent.delete':
      _identity?.deleteAgent(kwargs.agent_id);
      return { success: true };

    case 'aicq.chat.send':
      return await _chat?.sendMessage(currentAgentId, kwargs.targetId, kwargs.content, { isGroup: kwargs.isGroup });

    case 'aicq.chat.history':
      return { messages: _db?.getChatHistory(currentAgentId, kwargs.targetId, { limit: kwargs.limit || 50 }) || [] };

    case 'aicq.chat.streamChunk': {
      if (!kwargs.friend_id && !kwargs.targetId) return { error: 'friend_id or targetId is required' };
      if (!kwargs.data) return { error: 'data is required' };
      const chunkType = kwargs.chunk_type || kwargs.chunkType || 'text';
      const ALLOWED_CHUNK_TYPES = ['text', 'reasoning', 'thinking', 'clear_text', 'tool_call', 'tool_result'];
      if (!ALLOWED_CHUNK_TYPES.includes(chunkType)) return { error: `Invalid chunk_type: ${chunkType}. Allowed: ${ALLOWED_CHUNK_TYPES.join(', ')}` };
      const streamTarget = kwargs.friend_id || kwargs.targetId;
      const sent = _serverClient?.sendWS({
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
      const endSent = _serverClient?.sendWS({
        type: 'stream_end',
        to: endTarget,
        messageId: msgId,
      });
      if (!endSent) return { error: 'Not connected to server', success: false };
      return { success: true, messageId: msgId };
    }

    case 'aicq.groups.list':
      return { groups: _db?.listGroups(currentAgentId) || [] };

    case 'aicq.groups.create': {
      await _serverClient?.ensureAuth(currentAgentId);
      const result = await _serverClient?.createGroup(kwargs.name, kwargs.description);
      if (result?.id) {
        _db?.addGroup({
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
      await _serverClient?.ensureAuth(currentAgentId);
      return await _serverClient?.inviteGroupMember(kwargs.group_id, currentAgentId);

    case 'aicq.groups.messages': {
      await _serverClient?.ensureAuth(currentAgentId);
      return await _serverClient?.getGroupMessages(kwargs.group_id, kwargs.limit || 50);
    }

    case 'aicq.groups.silent':
      _db?.setGroupSilentMode(currentAgentId, kwargs.group_id, !!kwargs.silent);
      return { success: true, silent: !!kwargs.silent };

    default:
      return { error: `Unknown method: ${method}` };
  }
}

// Individual method exports (for direct registration)
export async function getStatus(kwargs, ctx) { return handleGateway('aicq.status', kwargs, ctx); }
export async function listFriends(kwargs, ctx) { return handleGateway('aicq.friends.list', kwargs, ctx); }
export async function addFriend(kwargs, ctx) { return handleGateway('aicq.friends.add', kwargs, ctx); }
export async function removeFriend(kwargs, ctx) { return handleGateway('aicq.friends.remove', kwargs, ctx); }
export async function listFriendRequests(kwargs, ctx) { return handleGateway('aicq.friends.requests', kwargs, ctx); }
export async function acceptFriendRequest(kwargs, ctx) { return handleGateway('aicq.friends.acceptRequest', kwargs, ctx); }
export async function rejectFriendRequest(kwargs, ctx) { return handleGateway('aicq.friends.rejectRequest', kwargs, ctx); }
export async function getIdentityInfo(kwargs, ctx) { return handleGateway('aicq.identity.info', kwargs, ctx); }
export async function createAgent(kwargs, ctx) { return handleGateway('aicq.agent.create', kwargs, ctx); }
export async function deleteAgent(kwargs, ctx) { return handleGateway('aicq.agent.delete', kwargs, ctx); }
export async function chatSend(kwargs, ctx) { return handleGateway('aicq.chat.send', kwargs, ctx); }
export async function chatHistory(kwargs, ctx) { return handleGateway('aicq.chat.history', kwargs, ctx); }
export async function chatStreamChunk(kwargs, ctx) { return handleGateway('aicq.chat.streamChunk', kwargs, ctx); }
export async function chatStreamEnd(kwargs, ctx) { return handleGateway('aicq.chat.streamEnd', kwargs, ctx); }
export async function listGroups(kwargs, ctx) { return handleGateway('aicq.groups.list', kwargs, ctx); }
export async function createGroup(kwargs, ctx) { return handleGateway('aicq.groups.create', kwargs, ctx); }
export async function joinGroup(kwargs, ctx) { return handleGateway('aicq.groups.join', kwargs, ctx); }
export async function getGroupMessages(kwargs, ctx) { return handleGateway('aicq.groups.messages', kwargs, ctx); }
export async function setGroupSilent(kwargs, ctx) { return handleGateway('aicq.groups.silent', kwargs, ctx); }
