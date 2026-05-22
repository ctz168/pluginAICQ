"""AICQ Plugin — chat-export-key tool for QR key export."""

from __future__ import annotations

from typing import Optional


class ChatExportKeyTool:
    """OpenClaw tool for exporting the private key as a password-protected QR code.

    Rate-limited to 3 exports per 5 minutes.
    """

    name = "chat-export-key"
    description = "Export private key as password-protected QR code (rate-limited)"

    def __init__(self, identity_service):
        self._identity = identity_service

    async def execute(self, password: str) -> dict:
        """Export the private key as a QR code.

        Args:
            password: Password to encrypt the key with.
        """
        if not password:
            return {"error": "password is required"}

        try:
            result = await self._identity.export_private_key_qr(password)
            return {
                "success": True,
                "qr_data_url": result.get("qr_data_url", ""),
                "expires_at": result.get("expires_at", ""),
            }
        except RuntimeError as exc:
            return {"error": str(exc)}
        except Exception as exc:
            return {"error": f"Export failed: {exc}"}
