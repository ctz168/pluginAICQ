/**
 * AICQ Chat Manager — Send/receive messages, group chat, file handling
 */
const { encryptMessage, decryptMessage } = require('./crypto');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ChatManager {
  constructor(identityManager, serverClient, db, uploadsDir) {
    this.identity = identityManager;
    this.server = serverClient;
    this.db = db;
    this.uploadsDir = uploadsDir;
    this._onNewMessage = null;

    // Listen for incoming messages via WS
    this.server.onMessage('relay', (data) => this._handleIncoming(data));
    this.server.onMessage('message', (data) => this._handleIncoming(data));
    this.server.onMessage('group_message', (data) => this._handleGroupIncoming(data));
    this.server.onMessage('handshake_initiate', (data) => this._handleHandshakeRequest(data));
    this.server.onMessage('presence', (data) => this._handlePresence(data));
    this.server.onMessage('file_chunk', (data) => this._handleFileChunk(data));
    this.server.onMessage('stream_chunk', (data) => this._handleStreamChunk(data));
    this.server.onMessage('stream_end', (data) => this._handleStreamEnd(data));
  }

  setOnNewMessage(callback) {
    this._onNewMessage = callback;
  }

  // ─── Send Messages ────────────────────────────────────────────────

  async sendMessage(agentId, targetId, content, { type = 'text', isGroup = false, mentions = [], file_url = null, file_name = null } = {}) {
    const identity = this.identity.loadAgent(agentId);

    if (isGroup) {
      // Group message via WebSocket
      const sent = this.server.sendWS({
        type: 'group_message',
        groupId: targetId,
        content,
        msgType: type,
        mentions,
      });

      // Save locally
      const msg = this.db.saveMessage({
        agent_id: agentId,
        target_id: targetId,
        from_id: agentId,
        to_id: targetId,
        type,
        content,
        file_url,
        file_name,
        is_group: 1,
        mentions,
        status: sent ? 'sent' : 'pending',
      });

      if (this._onNewMessage) this._onNewMessage(msg);
      return msg;
    }

    // Direct message
    // Try to encrypt if we have a session key
    const session = this.db.loadSession(agentId, targetId);
    let payload = content;
    if (session && session.session_key) {
      try {
        payload = encryptMessage(content, session.session_key);
      } catch (e) {
        console.error('[Chat] Encryption failed, sending plaintext:', e.message);
      }
    }

    // Send via WebSocket relay
    const sent = this.server.sendWS({
      type: 'relay',
      targetId: targetId,
      payload,
    });

    // Also try REST fallback
    if (!sent) {
      try {
        await this.server._request('POST', '/messages/send', {
          targetId,
          payload,
        });
      } catch (e) {
        // Queue offline
        this.db.enqueueOffline({
          agent_id: agentId,
          target_id: targetId,
          data: JSON.stringify({ type: 'relay', targetId, payload }),
        });
      }
    }

    // Save locally
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: targetId,
      from_id: agentId,
      to_id: targetId,
      type,
      content,
      file_url,
      file_name,
      is_group: 0,
      mentions,
      status: sent ? 'sent' : 'pending',
    });

    // Update session message count
    if (session) {
      this.db.incrementSessionMessageCount(agentId, targetId);
    }

    if (this._onNewMessage) this._onNewMessage(msg);
    return msg;
  }

  // ─── Receive Messages ─────────────────────────────────────────────

  _handleIncoming(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.fromId || data.from;
    let content = data.payload || data.data || '';

    // Try to decrypt if we have a session key
    const session = this.db.loadSession(agentId, fromId);
    if (session && session.session_key && typeof content === 'string') {
      try {
        content = decryptMessage(content, session.session_key);
      } catch (e) {
        // Might be plaintext, keep as is
      }
    }

    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: fromId,
      from_id: fromId,
      to_id: agentId,
      type: 'text',
      content: typeof content === 'string' ? content : JSON.stringify(content),
      is_group: 0,
      status: 'delivered',
    });

    if (this._onNewMessage) this._onNewMessage(msg);
  }

  _handleGroupIncoming(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.fromId;
    const groupId = data.groupId;

    // Check silent mode
    const silent = this.db.getGroupSilentMode(agentId, groupId);
    const mentions = data.mentions || [];
    const isMentioned = mentions.includes(agentId) || mentions.includes('all');

    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: groupId,
      from_id: fromId,
      to_id: groupId,
      type: data.msgType || 'text',
      content: data.content || '',
      is_group: 1,
      mentions,
      status: (silent && !isMentioned) ? 'silent' : 'delivered',
    });

    if (this._onNewMessage) this._onNewMessage(msg);
  }

  _handleHandshakeRequest(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    this.db.savePendingRequest({
      agent_id: agentId,
      session_id: data.sessionId || crypto.randomUUID(),
      requester_id: data.requesterId || data.from,
      requester_public_key: data.requesterPublicKey || data.exchangePublicKey || '',
    });
  }

  _handlePresence(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const friendId = data.nodeId;
    const isOnline = data.online === true || data.status === 'online';
    this.db.updateFriendOnline(agentId, friendId, isOnline);
  }

  _handleFileChunk(data) {
    // File chunk handling — assemble in uploads dir
    // For now, just log
    console.log('[Chat] File chunk from', data.from);
  }

  _handleStreamChunk(data) {
    // Incoming streaming chunk from another agent
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.from;
    const chunkType = data.chunkType || 'text';
    const chunkData = data.data;

    // Notify callback so OpenClaw agent can process streaming input
    if (this._onNewMessage) {
      this._onNewMessage({
        type: 'stream_chunk',
        from_id: fromId,
        chunk_type: chunkType,
        data: chunkData,
      });
    }
    console.log('[Chat] Stream chunk from', fromId, 'type:', chunkType);
  }

  _handleStreamEnd(data) {
    // Incoming stream end signal from another agent
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.from;
    const messageId = data.messageId || '';

    // Notify callback so OpenClaw agent knows stream is complete
    if (this._onNewMessage) {
      this._onNewMessage({
        type: 'stream_end',
        from_id: fromId,
        message_id: messageId,
      });
    }
    console.log('[Chat] Stream end from', fromId, 'messageId:', messageId);
  }

  // ─── Chat History ─────────────────────────────────────────────────

  getHistory(agentId, targetId, { limit = 50, before = null } = {}) {
    return this.db.getChatHistory(agentId, targetId, { limit, before });
  }

  deleteMessage(agentId, messageId) {
    this.db.deleteMessage(agentId, messageId);
  }

  // ─── File Upload ──────────────────────────────────────────────────

  async handleFileUpload(agentId, targetId, file, isGroup = false) {
    const fileId = crypto.randomUUID();
    const ext = path.extname(file.originalname || '.bin');
    const fileName = `${fileId}${ext}`;
    const filePath = path.join(this.uploadsDir, fileName);
    fs.writeFileSync(filePath, file.buffer);

    const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(ext);

    // Send message with file reference
    const msg = await this.sendMessage(agentId, targetId, isImage ? '[图片]' : `[文件] ${file.originalname}`, {
      type: isImage ? 'image' : 'file',
      isGroup,
      file_url: `/api/files/${fileName}`,
      file_name: file.originalname,
    });

    return msg;
  }
}

module.exports = ChatManager;
