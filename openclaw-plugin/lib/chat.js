/**
 * AICQ Chat Manager — Send/receive messages, group chat, file/image handling
 *
 * v3.9.0: File/image receiving redesigned.
 *         Incoming files are saved to userfiles/ directory first,
 *         then a simulated user message is dispatched to the AI agent
 *         telling it about the uploaded file with full path info.
 *         The agent can then read and process the file.
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

    // userfiles/ directory — where received files are saved for agent processing
    this.userfilesDir = path.join(path.dirname(uploadsDir), 'userfiles');

    // Ensure directories exist
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    if (!fs.existsSync(this.userfilesDir)) {
      fs.mkdirSync(this.userfilesDir, { recursive: true });
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
      // This is a structured message with file info — save to userfiles and notify agent
      const fileInfo = data.data.file_info;
      const msgType = fileInfo.isImage ? 'image' : 'file';
      this._saveToUserfilesAndNotify(agentId, fromId, fileInfo, data.data, { isGroup: false });
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
      // File/image in group message — save to userfiles and notify agent
      let fileInfo = {};
      try {
        fileInfo = typeof content === 'string' ? JSON.parse(content) : content;
      } catch (e) {}

      if (fileInfo.file_info) {
        this._saveToUserfilesAndNotify(agentId, groupId, fileInfo.file_info, fileInfo, { isGroup: true, fromId });
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

      // Save the assembled file to userfiles/ and notify the agent
      if (agentId) {
        // Move from uploads/ to userfiles/ for agent access
        const userfilesPath = path.join(this.userfilesDir, localFileName);
        try {
          // Copy to userfiles (keep original in uploads for HTTP serving)
          fs.copyFileSync(localPath, userfilesPath);
        } catch (e) {
          console.warn(`[Chat] Could not copy to userfiles: ${e.message}`);
        }

        // Save message to chat history
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

        // Notify agent with file path info
        if (this._onNewMessage) {
          this._notifyAgentAboutFile(agentId, fromId || '', meta.fileName, userfilesPath, msgType, isImage, { isGroup: false });
          this._onNewMessage(msg);
        }
      }

      console.log(`[Chat] File assembled and saved to userfiles: ${meta.fileName} (${fileBuffer.length} bytes)`);
    } catch (e) {
      console.error(`[Chat] File assembly failed for ${fileId}:`, e.message);
    } finally {
      this._incomingFiles.delete(fileId);

      // Check if there's a pending notification for this file
      if (this._pendingFileNotifications && this._pendingFileNotifications.has(fileId)) {
        const pending = this._pendingFileNotifications.get(fileId);
        this._pendingFileNotifications.delete(fileId);

        // The file is now assembled in uploads/ — copy to userfiles/
        const ext = this._extFromMime(meta?.mimeType) || path.extname(meta?.fileName || '') || '.bin';
        const localFileName = `${fileId}${ext}`;
        const localPath = path.join(this.uploadsDir, localFileName);
        const userfilesPath = path.join(this.userfilesDir, pending.safeName);

        if (fs.existsSync(localPath)) {
          try {
            fs.copyFileSync(localPath, userfilesPath);
            this._notifyAgentAboutFile(
              pending.agentId, pending.fromId, pending.originalName,
              userfilesPath, pending.msgType, pending.isImage,
              { isGroup: pending.isGroup }
            );
            console.log(`[Chat] Pending notification sent for assembled file: ${pending.originalName}`);
          } catch (e2) {
            console.warn(`[Chat] Failed to copy assembled file to userfiles: ${e2.message}`);
          }
        }
      }
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

  // ─── Userfiles: save received file and notify agent ─────────────

  /**
   * Save a received file to userfiles/ directory and notify the AI agent
   * that a file was uploaded. This creates a simulated user message
   * telling the agent about the file with its full path.
   *
   * @param {string} agentId - The local agent ID
   * @param {string} chatId - The chat/session ID (friend or group)
   * @param {object} fileInfo - File metadata { fileName, fileSize, mimeType, isImage }
   * @param {object} rawData - The raw message data (may contain base64 content)
   * @param {object} opts - { isGroup, fromId }
   */
  _saveToUserfilesAndNotify(agentId, chatId, fileInfo, rawData, opts = {}) {
    const { isGroup = false, fromId = chatId } = opts;
    const originalName = fileInfo.fileName || 'unknown';
    const isImage = fileInfo.isImage || this._isImageExt(path.extname(originalName));
    const msgType = isImage ? 'image' : 'file';

    // Generate a safe filename: timestamp_originalname to avoid collisions
    const safeName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const userfilesPath = path.join(this.userfilesDir, safeName);

    // Try to extract file data from the message
    let saved = false;

    // Case 1: file_info message may include base64 data in rawData.data
    if (rawData.data && typeof rawData.data === 'string') {
      try {
        const buffer = Buffer.from(rawData.data, 'base64');
        fs.writeFileSync(userfilesPath, buffer);
        saved = true;
        console.log(`[Chat] File saved to userfiles from base64 data: ${safeName} (${buffer.length} bytes)`);
      } catch (e) {
        console.warn(`[Chat] Failed to save file from base64 data: ${e.message}`);
      }
    }

    // Case 2: file_url might point to a local file in uploads/
    if (!saved && rawData.file_url) {
      const localFileName = path.basename(rawData.file_url);
      const localPath = path.join(this.uploadsDir, localFileName);
      if (fs.existsSync(localPath)) {
        try {
          fs.copyFileSync(localPath, userfilesPath);
          saved = true;
          console.log(`[Chat] File copied from uploads to userfiles: ${safeName}`);
        } catch (e) {
          console.warn(`[Chat] Failed to copy file from uploads: ${e.message}`);
        }
      }
    }

    // Case 3: If we have file_info with chunks, the file may still be
    // downloading via file_chunk messages. In that case, we set up a
    // pending notification that will be sent when _assembleFile completes.
    if (!saved && fileInfo.fileId) {
      // Store the notification info for when the file is fully assembled
      if (!this._pendingFileNotifications) {
        this._pendingFileNotifications = new Map();
      }
      this._pendingFileNotifications.set(fileInfo.fileId, {
        agentId, chatId, fromId, originalName, msgType, isImage, isGroup, safeName,
      });
      console.log(`[Chat] File ${originalName} pending assembly (fileId=${fileInfo.fileId}), notification queued`);
    }

    // Save message to chat history
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: chatId,
      from_id: fromId,
      to_id: agentId,
      type: msgType,
      content: isImage ? `[图片] ${originalName}` : `[文件] ${originalName}`,
      file_url: rawData.file_url || `/userfiles/${safeName}`,
      file_name: originalName,
      is_group: isGroup ? 1 : 0,
      status: saved ? 'delivered' : 'pending',
    });

    // Notify the agent about the file
    if (saved) {
      this._notifyAgentAboutFile(agentId, fromId, originalName, userfilesPath, msgType, isImage, opts);
    }

    if (this._onNewMessage) this._onNewMessage(msg);
  }

  /**
   * Notify the AI agent about a received file by sending a simulated
   * user message that describes the file and its location.
   *
   * @param {string} agentId - The local agent ID
   * @param {string} fromId - The sender ID
   * @param {string} fileName - Original file name
   * @param {string} filePath - Absolute path to the saved file in userfiles/
   * @param {string} msgType - 'image' or 'file'
   * @param {boolean} isImage - Whether this is an image
   * @param {object} opts - { isGroup, caption }
   */
  _notifyAgentAboutFile(agentId, fromId, fileName, filePath, msgType, isImage, opts = {}) {
    const { isGroup = false, caption = '' } = opts;
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const mimeType = this._getMimeType(fileName);

    // Build a descriptive message for the AI agent
    let agentMessage;
    if (isImage) {
      agentMessage = [
        `[用户上传了图片]`,
        `文件名: ${fileName}`,
        `文件路径: ${filePath}`,
        `文件大小: ${this._formatFileSize(fileSize)}`,
        `文件类型: ${mimeType}`,
        caption ? `说明: ${caption}` : '',
        `请查看并处理这张图片。`,
      ].filter(Boolean).join('\n');
    } else {
      agentMessage = [
        `[用户上传了文件]`,
        `文件名: ${fileName}`,
        `文件路径: ${filePath}`,
        `文件大小: ${this._formatFileSize(fileSize)}`,
        `文件类型: ${mimeType}`,
        caption ? `说明: ${caption}` : '',
        `请读取并处理这个文件。`,
      ].filter(Boolean).join('\n');
    }

    // Save this as a text message in chat history so the agent sees it
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: fromId,
      from_id: fromId,
      to_id: agentId,
      type: 'text',
      content: agentMessage,
      file_url: filePath,
      file_name: fileName,
      is_group: isGroup ? 1 : 0,
      status: 'delivered',
    });

    // Trigger the onNewMessage callback so the channel.js inbound handler
    // picks it up and dispatches it to the AI agent
    if (this._onNewMessage) {
      this._onNewMessage(msg);
    }

    console.log(`[Chat] Agent notification sent: ${msgType} ${fileName} at ${filePath}`);
  }

  /**
   * Format file size in human-readable format.
   */
  _formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  /**
   * List all files in the userfiles directory.
   * @returns {Array} Array of file info objects
   */
  listUserfiles() {
    if (!fs.existsSync(this.userfilesDir)) return [];
    return fs.readdirSync(this.userfilesDir)
      .filter(name => !name.startsWith('.'))
      .map(name => {
        const fullPath = path.join(this.userfilesDir, name);
        try {
          const stat = fs.statSync(fullPath);
          return {
            name,
            path: fullPath,
            size: stat.size,
            mimeType: this._getMimeType(name),
            isImage: this._isImageExt(path.extname(name)),
            modifiedAt: stat.mtime.toISOString(),
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Get the userfiles directory path.
   * @returns {string} Absolute path to userfiles directory
   */
  getUserfilesDir() {
    return this.userfilesDir;
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
