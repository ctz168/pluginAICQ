"""AICQ Plugin — File Transfer Manager."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from typing import Optional, Callable

CHUNK_SIZE = 64 * 1024  # 64 KB


@dataclass
class TransferState:
    session_id: str
    friend_id: str
    direction: str  # 'send' or 'receive'
    file_path: str
    file_hash: str
    file_size: int
    total_chunks: int
    chunks_sent: list = field(default_factory=list)
    chunks_received: list = field(default_factory=list)
    status: str = "pending"
    start_time: float = 0.0
    bytes_transferred: int = 0


class FileTransferManager:
    """Chunked file transfer with pause/resume/cancel support."""

    def __init__(self, send_fn: Optional[Callable] = None):
        self._send_fn = send_fn
        self._transfers: dict[str, TransferState] = {}
        self._progress_cbs: list[Callable] = []

    def set_send_function(self, fn: Callable) -> None:
        self._send_fn = fn

    def on_progress(self, callback: Callable) -> None:
        self._progress_cbs.append(callback)

    async def send_file(self, friend_id: str, file_path: str) -> str:
        """Start sending a file. Returns the session ID."""
        with open(file_path, "rb") as f:
            data = f.read()

        file_hash = hashlib.sha256(data).hexdigest()
        file_size = len(data)
        total_chunks = max(1, (file_size + CHUNK_SIZE - 1) // CHUNK_SIZE)
        session_id = base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("=")

        transfer = TransferState(
            session_id=session_id,
            friend_id=friend_id,
            direction="send",
            file_path=file_path,
            file_hash=file_hash,
            file_size=file_size,
            total_chunks=total_chunks,
            chunks_sent=[False] * total_chunks,
            start_time=time.time(),
            status="transferring",
        )
        self._transfers[session_id] = transfer

        # Send chunks
        for i in range(total_chunks):
            if transfer.status != "transferring":
                break
            start = i * CHUNK_SIZE
            end = min(start + CHUNK_SIZE, file_size)
            chunk = data[start:end]

            if self._send_fn:
                payload = json.dumps({
                    "type": "file_chunk_data",
                    "sessionId": session_id,
                    "chunkIndex": i,
                    "chunkData": base64.b64encode(chunk).decode("ascii"),
                }).encode("utf-8")
                self._send_fn(friend_id, payload)

            transfer.chunks_sent[i] = True
            transfer.bytes_transferred += len(chunk)

        if transfer.status == "transferring":
            transfer.status = "completed"

        return session_id

    async def receive_file(self, session_id: str, save_path: str, file_hash: str,
                           file_size: int, total_chunks: int) -> None:
        """Prepare to receive a file."""
        transfer = TransferState(
            session_id=session_id,
            friend_id="",
            direction="receive",
            file_path=save_path,
            file_hash=file_hash,
            file_size=file_size,
            total_chunks=total_chunks,
            chunks_received=[False] * total_chunks,
            start_time=time.time(),
            status="transferring",
        )
        self._transfers[session_id] = transfer

    def handle_chunk(self, session_id: str, chunk_index: int, chunk_data: str) -> None:
        """Process an incoming file chunk."""
        transfer = self._transfers.get(session_id)
        if not transfer or transfer.status != "transferring":
            return

        try:
            chunk = base64.b64decode(chunk_data)
            temp_path = transfer.file_path + ".tmp"
            offset = chunk_index * CHUNK_SIZE

            os.makedirs(os.path.dirname(temp_path) or ".", exist_ok=True)
            mode = "r+b" if os.path.exists(temp_path) else "w+b"
            with open(temp_path, mode) as f:
                f.seek(offset)
                f.write(chunk)

            if chunk_index < len(transfer.chunks_received):
                transfer.chunks_received[chunk_index] = True
            transfer.bytes_transferred += len(chunk)

            if all(transfer.chunks_received[:transfer.total_chunks]):
                transfer.status = "completed"
                # Verify hash
                with open(temp_path, "rb") as f:
                    data = f.read()
                actual = hashlib.sha256(data).hexdigest()
                if actual == transfer.file_hash:
                    os.rename(temp_path, transfer.file_path)
                else:
                    os.unlink(temp_path)
                    transfer.status = "failed"

        except Exception as exc:
            print(f"[FileTransfer] Chunk write error: {exc}")

    def pause(self, session_id: str) -> None:
        t = self._transfers.get(session_id)
        if t:
            t.status = "paused"

    def cancel(self, session_id: str) -> None:
        t = self._transfers.pop(session_id, None)
        if t:
            t.status = "cancelled"
            tmp = t.file_path + ".tmp"
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except Exception:
                    pass

    def destroy(self) -> None:
        for sid in list(self._transfers):
            self.cancel(sid)
        self._transfers.clear()
