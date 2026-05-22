"""
AICQ Plugin Configuration
==========================
Loads plugin configuration from multiple sources with a clear precedence:

1. Environment variables (highest priority)
2. Config file at ``~/.aicq-plugin/config.json``
3. ``openclaw.json`` in the working directory (if present)
4. Built-in defaults (lowest priority)
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .types import PluginConfig

logger = logging.getLogger("aicq.plugin.config")

# ─── Defaults ───────────────────────────────────────────────────────────

_DEFAULTS: Dict[str, Any] = {
    "server_url": "https://aicq.online",
    "max_friends": 200,
    "auto_accept_friends": True,
    "data_dir": "~/.aicq-plugin",
}

# ─── Environment variable mapping ──────────────────────────────────────

_ENV_MAP: Dict[str, str] = {
    "AICQ_SERVER_URL": "server_url",
    "AICQ_AGENT_ID": "agent_id",
    "AICQ_MAX_FRIENDS": "max_friends",
    "AICQ_AUTO_ACCEPT_FRIENDS": "auto_accept_friends",
    "AICQ_DATA_DIR": "data_dir",
}


def _env_bool(value: str) -> bool:
    """Parse a boolean from an environment variable string."""
    return value.strip().lower() in ("true", "1", "yes", "on")


def _env_int(value: str) -> int:
    """Parse an integer from an environment variable string."""
    return int(value.strip())


def _load_from_env() -> Dict[str, Any]:
    """Read configuration values from environment variables.

    Only includes keys whose corresponding env var is actually set.
    """
    result: Dict[str, Any] = {}

    for env_key, config_key in _ENV_MAP.items():
        value = os.environ.get(env_key)
        if value is None:
            continue

        # Type coercion based on expected type
        if config_key == "max_friends":
            result[config_key] = _env_int(value)
        elif config_key == "auto_accept_friends":
            result[config_key] = _env_bool(value)
        else:
            result[config_key] = value.strip()

    return result


def _load_from_config_file(path: Path) -> Dict[str, Any]:
    """Load configuration from a JSON config file.

    Returns an empty dict if the file does not exist or is invalid.
    """
    if not path.is_file():
        return {}

    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
        if isinstance(data, dict):
            logger.debug("Loaded config from %s", path)
            return data
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read config file %s: %s", path, exc)

    return {}


def _load_from_openclaw_json() -> Dict[str, Any]:
    """Load AICQ-relevant settings from ``openclaw.json`` if present.

    Looks for an ``aicq`` key inside the openclaw.json file in CWD.
    """
    openclaw_path = Path.cwd() / "openclaw.json"
    if not openclaw_path.is_file():
        return {}

    try:
        data = json.loads(openclaw_path.read_text(encoding="utf-8"))
        aicq_section = data.get("aicq", {})
        if isinstance(aicq_section, dict):
            logger.debug("Loaded aicq config from openclaw.json")
            return aicq_section
    except (json.JSONDecodeError, OSError) as exc:
        logger.debug("Could not read openclaw.json: %s", exc)

    return {}


def load_config(
    config_path: Optional[str] = None,
    override: Optional[Dict[str, Any]] = None,
) -> PluginConfig:
    """Load and merge configuration from all sources.

    Precedence (highest first):
    1. *override* dict (programmatic overrides)
    2. Environment variables
    3. Config file (default ``~/.aicq-plugin/config.json``)
    4. ``openclaw.json`` in CWD
    5. Built-in defaults

    Parameters
    ----------
    config_path:
        Explicit path to a JSON config file. When ``None``, the default
        path ``~/.aicq-plugin/config.json`` is used.
    override:
        Optional dict of configuration values that take the highest
        priority (useful for programmatic setup).

    Returns
    -------
    PluginConfig
        Fully resolved configuration object.
    """
    # Determine config file path
    if config_path:
        cfg_path = Path(config_path).expanduser()
    else:
        cfg_path = Path("~/.aicq-plugin/config.json").expanduser()

    # Layer 4: defaults
    merged: Dict[str, Any] = dict(_DEFAULTS)

    # Layer 3: openclaw.json
    openclaw_data = _load_from_openclaw_json()
    merged.update(openclaw_data)

    # Layer 2: config file
    file_data = _load_from_config_file(cfg_path)
    merged.update(file_data)

    # Layer 1: environment variables
    env_data = _load_from_env()
    merged.update(env_data)

    # Layer 0: programmatic overrides
    if override:
        merged.update(override)

    # Filter to only known fields
    valid_keys = {f.name for f in PluginConfig.__dataclass_fields__.values()}  # type: ignore[attr-defined]
    filtered = {k: v for k, v in merged.items() if k in valid_keys}

    config = PluginConfig(**filtered)

    # Ensure data_dir is expanded
    config.data_dir = str(Path(config.data_dir).expanduser())

    # Ensure the data directory exists
    Path(config.data_dir).mkdir(parents=True, exist_ok=True)

    logger.info(
        "Plugin config loaded: server=%s agent=%s max_friends=%d auto_accept=%s",
        config.server_url,
        config.agent_id or "(not set)",
        config.max_friends,
        config.auto_accept_friends,
    )
    return config
