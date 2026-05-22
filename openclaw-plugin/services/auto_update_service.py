"""AICQ Plugin — Auto-update service."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Optional

try:
    from packaging.version import Version
    HAS_PACKAGING = True
except ImportError:
    HAS_PACKAGING = False

try:
    import aiohttp
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False


class AutoUpdateService:
    """Checks for new versions of the aicq-plugin on PyPI and auto-installs.

    Checks every 6 hours by default.
    """

    CHECK_INTERVAL = 6 * 3600  # 6 hours
    PYPI_URL = "https://pypi.org/pypi/aicq-plugin/json"

    def __init__(self, current_version: str = "2.0.0"):
        self._current_version = current_version
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        """Start the periodic update check."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._check_loop())

    async def stop(self) -> None:
        """Stop the periodic update check."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _check_loop(self) -> None:
        while self._running:
            try:
                await self._check_and_update()
            except Exception as exc:
                print(f"[AutoUpdate] Check failed: {exc}")
            await asyncio.sleep(self.CHECK_INTERVAL)

    async def _check_and_update(self) -> None:
        """Check PyPI for a newer version and install if available."""
        if not HAS_AIOHTTP or not HAS_PACKAGING:
            return

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(self.PYPI_URL, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status != 200:
                        return
                    data = await resp.json(content_type=None)

            latest = data.get("info", {}).get("version", "")
            if not latest:
                return

            if Version(latest) > Version(self._current_version):
                print(f"[AutoUpdate] New version available: {latest} (current: {self._current_version})")
                await self._install_update(latest)
        except Exception as exc:
            print(f"[AutoUpdate] Version check failed: {exc}")

    async def _install_update(self, version: str) -> None:
        """Install the new version via pip."""
        import subprocess
        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--upgrade", "aicq-plugin"],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode == 0:
                print(f"[AutoUpdate] Updated to {version}")
                self._current_version = version
            else:
                print(f"[AutoUpdate] Install failed: {result.stderr}")
        except Exception as exc:
            print(f"[AutoUpdate] Install error: {exc}")
