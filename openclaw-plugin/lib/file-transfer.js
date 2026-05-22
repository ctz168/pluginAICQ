/**
 * AICQ File Transfer
 * ====================
 * Handles chunked file upload/download via WebSocket.
 * Files are encrypted with session keys before transmission.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('./crypto');
const { v4: uuidv4 } = require('uuid');
const { isoNow } = require('./database');

const CHUNK_SIZE = 65536; // 64KB chunks
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

class FileTransferManager {
  constructor(db, identity, serverClient) {
    this.db = db;
    this.identity = identity;
    this.serverClient = serverClient;

    // In-progress transfers: fileId -> { chunks, meta }
    this._incoming = new Map();

    // Ensure uploads directory exists
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
  }

  /**
   * Upload a file to a friend.
   * Reads the file, encrypts chunks, and sends via WebSocket.
   */
  uploadFile(targetId, filePath, { isGroup = false } = {}) {
    const agentId = this.identity.currentAgentId;
    if (!agentId) throw new Error('No agent selected');

    const identity = this.identity.getCurrent();
    if (!identity) throw new Error('No identity');

    const fileId = uuidv4();
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const fileSize = fileBuffer.length;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    // Get session key for encryption
    let sessionKey = null;
    if (!isGroup) {
      const session = this.db.loadSession(agentId, targetId);
      if (session) {
        sessionKey = session.session_key;
      } else {
        const friend = this.db.getFriend(agentId, targetId);
        if (friend && friend.public_key) {
          sessionKey = crypto.sha256Hex(crypto.computeSharedSecret(identity.exchangeSecretKey, friend.public_key));
          this.db.saveSession(agentId, targetId, sessionKey);
        }
      }
    }

    // Save file locally
    const localPath = path.join(UPLOADS_DIR, fileId);
    fs.writeFileSync(localPath, fileBuffer);

    // Send file info message first
    const fileInfo = {
      fileId,
      fileName,
      fileSize,
      totalChunks,
      mimeType: this._getMimeType(fileName),
    };

    // Save file-info message to chat history
    this.db.saveMessage({
      agentId,
      targetId,
      fromId: identity.agentId,
      toId: targetId,
      type: 'file',
      content: JSON.stringify(fileInfo),
      status: 'sent',
      isGroup,
    });

    // Send file info via WS
    if (!isGroup) {
      this.serverClient.sendWs({
        type: 'message',
        to: targetId,
        data: JSON.stringify({ type: 'file-info', ...fileInfo }),
      });
    } else {
      this.serverClient.sendWs({
        type: 'group_message',
        groupId: targetId,
        content: JSON.stringify({ type: 'file-info', ...fileInfo }),
        msgType: 'file',
      });
    }

    // Send chunks
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      let chunkData = fileBuffer.slice(start, end);

      const chunk = {
        fileId,
        index: i,
        total: totalChunks,
        data: chunkData.toString('base64'),
      };

      if (sessionKey && !isGroup) {
        // Encrypt chunk
        const encrypted = crypto.encryptFileChunk(sessionKey, chunkData, i);
        chunk.data = encrypted.ciphertext;
        chunk.nonce = encrypted.nonce;
        chunk.encrypted = true;
      }

      if (!isGroup) {
        this.serverClient.sendWs({
          type: 'file_chunk',
          to: targetId,
          data: chunk,
        });
      } else {
        this.serverClient.sendWs({
          type: 'group_message',
          groupId: targetId,
          content: JSON.stringify(chunk),
          msgType: 'file_chunk',
        });
      }
    }

    return { fileId, fileName, fileSize, totalChunks };
  }

  /**
   * Handle incoming file chunk.
   */
  handleFileChunk(data) {
    const chunkData = data.data || data;
    const fileId = chunkData.fileId;

    if (!fileId) return;

    // Initialize incoming transfer if needed
    if (!this._incoming.has(fileId)) {
      this._incoming.set(fileId, {
        chunks: new Map(),
        meta: null,
      });
    }

    const transfer = this._incoming.get(fileId);

    // If this is a file-info message
    if (chunkData.type === 'file-info') {
      transfer.meta = chunkData;
      return;
    }

    // Store the chunk
    transfer.chunks.set(chunkData.index, chunkData);

    // Check if all chunks received
    if (transfer.meta && transfer.chunks.size >= transfer.meta.totalChunks) {
      this._assembleFile(fileId, transfer);
    }
  }

  /**
   * Assemble received chunks into a complete file.
   */
  _assembleFile(fileId, transfer) {
    const { meta, chunks } = transfer;

    try {
      const sortedChunks = Array.from(chunks.entries())
        .sort((a, b) => a[0] - b[0]);

      const buffers = [];
      for (const [index, chunk] of sortedChunks) {
        if (chunk.encrypted) {
          // Decrypt chunk
          const agentId = this.identity.currentAgentId;
          const session = this.db.loadSession(agentId, transfer.fromId);
          if (session) {
            const decrypted = crypto.decryptFileChunk(
              session.session_key, chunk.nonce, chunk.data, index
            );
            buffers.push(decrypted);
          }
        } else {
          buffers.push(Buffer.from(chunk.data, 'base64'));
        }
      }

      const fileBuffer = Buffer.concat(buffers);

      // Save to uploads directory
      const localPath = path.join(UPLOADS_DIR, fileId);
      fs.writeFileSync(localPath, fileBuffer);

      // Save message to chat history
      const agentId = this.identity.currentAgentId;
      if (agentId) {
        this.db.saveMessage({
          agentId,
          targetId: meta.fromId || '',
          fromId: meta.fromId || '',
          toId: agentId,
          type: 'file',
          content: JSON.stringify({
            fileId,
            fileName: meta.fileName,
            fileSize: meta.fileSize,
            localPath,
          }),
          status: 'delivered',
          isGroup: false,
        });
      }

      console.log(`[FileTransfer] Assembled file ${meta.fileName} (${meta.fileSize} bytes)`);
    } catch (e) {
      console.error(`[FileTransfer] Assembly failed for ${fileId}:`, e.message);
    } finally {
      this._incoming.delete(fileId);
    }
  }

  /**
   * Serve an uploaded file.
   */
  serveFile(fileId) {
    const filePath = path.join(UPLOADS_DIR, fileId);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
    return null;
  }

  /**
   * Get MIME type from filename.
   */
  _getMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
      '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}

module.exports = FileTransferManager;
