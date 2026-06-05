/**
 * AICQ Chat Manager — Send/receive messages, group chat, file/image handling
 *
 * v3.8.0: Added file and image sending via WebSocket.
 *         Files are sent as base64 chunks through the 'message' WS type
 *         with type='file' or type='image', compatible with the AICQ
 *         server relay protocol and chat.html client.
 */
const { encryptMessage, decryptMessage } = require('./crypto');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_CHUNK_SIZE = 512 * 1024; // 512KB per WS chunk
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit

class ChatManager {
  constructor(identityManager, serverClient, db, uploadsDir) {
    this.identity = identityManager;
    this.server = serverClient;
    this.db = db;
    this.uploadsDir = uploadsDir;
    this._onNewMessage = null;

    // Ensure uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Listen for incoming messages via WS
    this.server.onMessage('relay', (data) => this._handleIncoming(data));
    this.server.onMessage('message', (data) => this._handleIncoming(data));
    this.server.onMessage('group_message', (data) => this._handleGroupIncoming(data));
    this.server.onMessage('handshake_initiate', (data) => this._handleHandshakeRequest(data));
    this.server.onMessage('presence', (data) => this._handlePresence(data));
    this.server.onMessage('file_chunk', (data) => this._handleFileChunk(data));
    this.server.onMessage('stream_chunk', (data) => this._handleStreamChunk(data));
    this.server.onMessage('stream_end', (data) => this._handleStreamEnd(data));

    // Incoming file transfer state: fileId -> { meta, chunks }
    this._incomingFiles = new Map();
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

  // ─── Send File ──────────────────────────────────────────────────

  /**
   * Send a file to a friend or group.
   *
   * Reads the file from disk, chunks it, and sends via WebSocket
   * using the AICQ 'message' protocol with type='file'.
   * The receiver's chat.html client will assemble and display the file.
   *
   * @param {string} agentId - Sender agent ID
   * @param {string} targetId - Recipient (friend ID or group ID)
   * @param {string} filePath - Local file path to send
   * @param {object} options - { isGroup, caption }
   * @returns {object} Send result with fileId, fileName, fileSize
   */
  async sendFile(agentId, targetId, filePath, { isGroup = false, caption = '' } = {}) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const originalName = path.basename(filePath);
    const ext = path.extname(originalName).toLowerCase();
    const mimeType = this._getMimeType(originalName);
    const isImage = this._isImageExt(ext);
    const msgType = isImage ? 'image' : 'file';

    // Generate a unique file ID
    const fileId = crypto.randomUUID();

    // Save a local copy in uploads dir
    const localFileName = `${fileId}${ext}`;
    const localPath = path.join(this.uploadsDir, localFileName);
    fs.writeFileSync(localPath, fileBuffer);

    // Build the file info message (compatible with chat.html client)
    const fileInfo = {
      id: `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      from_id: agentId,
      to_id: targetId,
      type: msgType,
      content: caption || (isImage ? '[图片]' : `[文件] ${originalName}`),
      file_info: {
        fileId,
        fileName: originalName,
        fileSize: stat.size,
        mimeType,
        isImage,
        chunks: Math.ceil(stat.size / FILE_CHUNK_SIZE),
      },
      file_url: `/api/files/${localFileName}`,
      file_name: originalName,
      created_at: new Date().toISOString(),
      status: 'sent',
    };

    // Send the file-info message first
    if (isGroup) {
      this.server.sendWS({
        type: 'group_message',
        groupId: targetId,
        from: agentId,
        content: JSON.stringify(fileInfo),
        msgType: msgType,
        timestamp: Date.now(),
      });
    } else {
      this.server.sendWS({
        type: 'message',
        to: targetId,
        data: fileInfo,
      });
    }

    // Send file data in chunks via file_chunk messages
    const totalChunks = Math.ceil(stat.size / FILE_CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * FILE_CHUNK_SIZE;
      const end = Math.min(start + FILE_CHUNK_SIZE, stat.size);
      const chunkBuffer = fileBuffer.slice(start, end);

      const chunkMsg = {
        fileId,
        index: i,
        total: totalChunks,
        data: chunkBuffer.toString('base64'),
      };

      if (isGroup) {
        this.server.sendWS({
          type: 'group_message',
          groupId: targetId,
          from: agentId,
          content: JSON.stringify(chunkMsg),
          msgType: 'file_chunk',
          timestamp: Date.now(),
        });
      } else {
        this.server.sendWS({
          type: 'file_chunk',
          to: targetId,
          data: chunkMsg,
        });
      }

      // Small delay between chunks to avoid WS flooding
      if (i < totalChunks - 1 && totalChunks > 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    // Save message to local chat history
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: targetId,
      from_id: agentId,
      to_id: targetId,
      type: msgType,
      content: caption || (isImage ? `[图片] ${originalName}` : `[文件] ${originalName}`),
      file_url: `/api/files/${localFileName}`,
      file_name: originalName,
      is_group: isGroup ? 1 : 0,
      status: 'sent',
    });

    if (this._onNewMessage) this._onNewMessage(msg);

    console.log(`[Chat] File sent: ${originalName} (${stat.size} bytes, ${totalChunks} chunks) to ${targetId}`);

    return {
      fileId,
      fileName: originalName,
      fileSize: stat.size,
      mimeType,
      isImage,
      totalChunks,
      localPath,
      message: msg,
    };
  }

  /**
   * Send an image from a buffer (e.g., generated by AI).
   *
   * @param {string} agentId - Sender agent ID
   * @param {string} targetId - Recipient
   * @param {Buffer} imageBuffer - Image data
   * @param {string} fileName - File name (e.g., 'image.png')
   * @param {object} options - { isGroup, caption }
   * @returns {object} Send result
   */
  async sendImageBuffer(agentId, targetId, imageBuffer, fileName = 'image.png', { isGroup = false, caption = '' } = {}) {
    if (!Buffer.isBuffer(imageBuffer)) {
      throw new Error('imageBuffer must be a Buffer');
    }

    // Save buffer to a temp file, then use sendFile
    const tempPath = path.join(this.uploadsDir, `temp_${Date.now()}_${fileName}`);
    fs.writeFileSync(tempPath, imageBuffer);

    try {
      const result = await this.sendFile(agentId, targetId, tempPath, { isGroup, caption });
      return result;
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }

  /**
   * Send a file from a base64-encoded string.
   *
   * @param {string} agentId - Sender agent ID
   * @param {string} targetId - Recipient
   * @param {string} base64Data - Base64-encoded file data
   * @param {string} fileName - File name
   * @param {object} options - { isGroup, caption, mimeType }
   * @returns {object} Send result
   */
  async sendFileFromBase64(agentId, targetId, base64Data, fileName, { isGroup = false, caption = '', mimeType = '' } = {}) {
    const buffer = Buffer.from(base64Data, 'base64');

    // Save to temp file
    const ext = path.extname(fileName) || this._extFromMime(mimeType) || '.bin';
    const tempPath = path.join(this.uploadsDir, `temp_${Date.now()}_${fileName}`);
    fs.writeFileSync(tempPath, buffer);

    try {
      const result = await this.sendFile(agentId, targetId, tempPath, { isGroup, caption });
      return result;
    } finally {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }

  // ─── Receive Messages ─────────────────────────────────────────────

  _handleIncoming(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.fromId || data.from;
    let content = data.payload || data.data || '';

    // Check if this is a file/image message in the new format
    if (typeof data === 'object' && data.data && typeof data.data === 'object' && data.data.file_info) {
      // This is a structured message with file info
      const fileInfo = data.data.file_info;
      const msgType = fileInfo.isImage ? 'image' : 'file';
      const msg = this.db.saveMessage({
        agent_id: agentId,
        target_id: fromId,
        from_id: fromId,
        to_id: agentId,
        type: msgType,
        content: data.data.content || (fileInfo.isImage ? '[图片]' : `[文件] ${fileInfo.fileName}`),
        file_url: data.data.file_url || '',
        file_name: fileInfo.fileName || '',
        is_group: 0,
        status: 'delivered',
      });
      if (this._onNewMessage) this._onNewMessage(msg);
      return;
    }

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

    const fromId = data.fromId || data.from;
    const groupId = data.groupId;

    // Check if this is a file/image message
    let content = data.content || '';
    const msgType = data.msgType || data.msg_type || 'text';

    if (msgType === 'file' || msgType === 'image') {
      // File/image in group message
      let fileInfo = {};
      try {
        fileInfo = typeof content === 'string' ? JSON.parse(content) : content;
      } catch (e) {}

      if (fileInfo.file_info) {
        const msg = this.db.saveMessage({
          agent_id: agentId,
          target_id: groupId,
          from_id: fromId,
          to_id: groupId,
          type: msgType,
          content: fileInfo.content || (fileInfo.file_info.isImage ? '[图片]' : `[文件] ${fileInfo.file_info.fileName}`),
          file_url: fileInfo.file_url || '',
          file_name: fileInfo.file_info.fileName || '',
          is_group: 1,
          status: 'delivered',
        });
        if (this._onNewMessage) this._onNewMessage(msg);
        return;
      }
    }

    // Check silent mode
    const silent = this.db.getGroupSilentMode(agentId, groupId);
    const mentions = data.mentions || [];
    const isMentioned = mentions.includes(agentId) || mentions.includes('all');

    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: groupId,
      from_id: fromId,
      to_id: groupId,
      type: msgType,
      content,
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
    // Handle incoming file chunks
    const chunkData = data.data || data;
    const fileId = chunkData.fileId;

    if (!fileId) return;

    // Initialize incoming transfer if needed
    if (!this._incomingFiles.has(fileId)) {
      this._incomingFiles.set(fileId, {
        chunks: new Map(),
        meta: null,
        fromId: data.from || data.fromId,
      });
    }

    const transfer = this._incomingFiles.get(fileId);

    // If this is a file-info message
    if (chunkData.type === 'file-info' || chunkData.file_info) {
      transfer.meta = chunkData.file_info || chunkData;
      return;
    }

    // Store the chunk
    transfer.chunks.set(chunkData.index, chunkData);

    // Check if all chunks received
    if (transfer.meta && transfer.chunks.size >= transfer.meta.chunks) {
      this._assembleFile(fileId, transfer);
    }
  }

  /**
   * Assemble received file chunks into a complete file.
   */
  _assembleFile(fileId, transfer) {
    const { meta, chunks, fromId } = transfer;

    try {
      const sortedChunks = Array.from(chunks.entries())
        .sort((a, b) => a[0] - b[0]);

      const buffers = [];
      for (const [index, chunk] of sortedChunks) {
        buffers.push(Buffer.from(chunk.data, 'base64'));
      }

      const fileBuffer = Buffer.concat(buffers);
      const agentId = this.server.currentAgentId;

      // Determine file extension
      const ext = this._extFromMime(meta.mimeType) || path.extname(meta.fileName) || '.bin';
      const localFileName = `${fileId}${ext}`;
      const localPath = path.join(this.uploadsDir, localFileName);

      // Save to uploads directory
      fs.writeFileSync(localPath, fileBuffer);

      const isImage = meta.isImage || this._isImageExt(ext);
      const msgType = isImage ? 'image' : 'file';

      // Save message to chat history
      if (agentId) {
        const msg = this.db.saveMessage({
          agent_id: agentId,
          target_id: fromId || '',
          from_id: fromId || '',
          to_id: agentId,
          type: msgType,
          content: isImage ? `[图片] ${meta.fileName}` : `[文件] ${meta.fileName}`,
          file_url: `/api/files/${localFileName}`,
          file_name: meta.fileName,
          is_group: 0,
          status: 'delivered',
        });
        if (this._onNewMessage) this._onNewMessage(msg);
      }

      console.log(`[Chat] File assembled: ${meta.fileName} (${fileBuffer.length} bytes)`);
    } catch (e) {
      console.error(`[Chat] File assembly failed for ${fileId}:`, e.message);
    } finally {
      this._incomingFiles.delete(fileId);
    }
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

  // ─── File Upload (from HTTP) ────────────────────────────────────

  async handleFileUpload(agentId, targetId, file, isGroup = false) {
    const fileId = crypto.randomUUID();
    const ext = path.extname(file.originalname || '.bin');
    const fileName = `${fileId}${ext}`;
    const filePath = path.join(this.uploadsDir, fileName);
    fs.writeFileSync(filePath, file.buffer);

    const isImage = this._isImageExt(ext);
    const msgType = isImage ? 'image' : 'file';

    // Build file info for WS message
    const fileInfo = {
      id: `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      from_id: agentId,
      to_id: targetId,
      type: msgType,
      content: isImage ? '[图片]' : `[文件] ${file.originalname}`,
      file_info: {
        fileId,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype || this._getMimeType(file.originalname),
        isImage,
        chunks: 1,
      },
      file_url: `/api/files/${fileName}`,
      file_name: file.originalname,
      created_at: new Date().toISOString(),
      status: 'sent',
    };

    // Send file-info message via WS
    if (isGroup) {
      this.server.sendWS({
        type: 'group_message',
        groupId: targetId,
        from: agentId,
        content: JSON.stringify(fileInfo),
        msgType: msgType,
        timestamp: Date.now(),
      });
    } else {
      this.server.sendWS({
        type: 'message',
        to: targetId,
        data: fileInfo,
      });
    }

    // If file is large enough, also send as file_chunk for assembly
    if (file.size > 0) {
      const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const start = i * FILE_CHUNK_SIZE;
        const end = Math.min(start + FILE_CHUNK_SIZE, file.size);
        const chunkBuffer = file.buffer.slice(start, end);

        const chunkMsg = {
          fileId,
          index: i,
          total: totalChunks,
          data: chunkBuffer.toString('base64'),
        };

        if (isGroup) {
          this.server.sendWS({
            type: 'group_message',
            groupId: targetId,
            from: agentId,
            content: JSON.stringify(chunkMsg),
            msgType: 'file_chunk',
            timestamp: Date.now(),
          });
        } else {
          this.server.sendWS({
            type: 'file_chunk',
            to: targetId,
            data: chunkMsg,
          });
        }
      }
    }

    // Save message locally
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: targetId,
      from_id: agentId,
      to_id: targetId,
      type: msgType,
      content: isImage ? `[图片] ${file.originalname}` : `[文件] ${file.originalname}`,
      file_url: `/api/files/${fileName}`,
      file_name: file.originalname,
      is_group: isGroup ? 1 : 0,
      status: 'sent',
    });

    if (this._onNewMessage) this._onNewMessage(msg);
    return msg;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  _isImageExt(ext) {
    return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|tif|avif)$/i.test(ext);
  }

  _getMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff',
      '.tif': 'image/tiff', '.avif': 'image/avif',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
      '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg',
      '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  _extFromMime(mimeType) {
    if (!mimeType) return '';
    const mimeToExt = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
      'application/pdf': '.pdf', 'text/plain': '.txt',
      'application/zip': '.zip', 'audio/mpeg': '.mp3',
      'video/mp4': '.mp4', 'audio/wav': '.wav',
    };
    return mimeToExt[mimeType] || '';
  }
}

module.exports = ChatManager;
