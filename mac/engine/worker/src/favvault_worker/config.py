"""Settings: ~/Library/Application Support/FavVault/settings.json, secrets in the macOS Keychain.

Environment variables override the file (handy for CLI use and tests):
  FAVVAULT_HOME, FAVVAULT_VAULT, FAVVAULT_LLM_BASE_URL, FAVVAULT_LLM_MODEL,
  FAVVAULT_LLM_API_KEY, FAVVAULT_ASR_ENGINE, FAVVAULT_ASR_MODEL
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

KEYCHAIN_SERVICE = "com.favvault.app"
KEYCHAIN_LLM_ACCOUNT = "llm-api-key"


def app_home() -> Path:
    env = os.environ.get("FAVVAULT_HOME")
    if env:
        return Path(env).expanduser()
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support" / "FavVault"
    return Path.home() / ".favvault"


def keychain_get(account: str, service: str = KEYCHAIN_SERVICE) -> str | None:
    if platform.system() != "Darwin":
        return None
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = out.stdout.strip()
    return value or None


@dataclass
class Settings:
    vault_path: Path | None = None
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"
    llm_api_key: str | None = None
    asr_engine: str = "auto"  # auto | apple | sensevoice | mlx | faster-whisper
    asr_model: str = ""  # empty = engine default
    cookies_from_browser: str | None = None  # e.g. "safari", "chrome"
    cookies_file: Path | None = None
    keep_media: bool = False
    home: Path = field(default_factory=app_home)

    @property
    def db_path(self) -> Path:
        return self.home / "state.sqlite3"

    @property
    def lock_path(self) -> Path:
        return self.home / "var" / "sync.lock"

    @property
    def media_dir(self) -> Path:
        return self.home / "media"

    @property
    def log_dir(self) -> Path:
        return self.home / "logs"


def load_settings() -> Settings:
    s = Settings()
    path = s.home / "settings.json"
    data: dict = {}
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("vaultPath"):
        s.vault_path = Path(data["vaultPath"]).expanduser()
    s.llm_base_url = data.get("llmBaseURL", s.llm_base_url)
    s.llm_model = data.get("llmModel", s.llm_model)
    s.asr_engine = data.get("asrEngine", s.asr_engine)
    s.asr_model = data.get("asrModel", s.asr_model)
    s.cookies_from_browser = data.get("cookiesFromBrowser") or None
    if data.get("cookiesFile"):
        s.cookies_file = Path(data["cookiesFile"]).expanduser()
    s.keep_media = bool(data.get("keepMedia", False))

    env = os.environ
    if env.get("FAVVAULT_VAULT"):
        s.vault_path = Path(env["FAVVAULT_VAULT"]).expanduser()
    s.llm_base_url = env.get("FAVVAULT_LLM_BASE_URL", s.llm_base_url)
    s.llm_model = env.get("FAVVAULT_LLM_MODEL", s.llm_model)
    s.asr_engine = env.get("FAVVAULT_ASR_ENGINE", s.asr_engine)
    s.asr_model = env.get("FAVVAULT_ASR_MODEL", s.asr_model)
    s.llm_api_key = env.get("FAVVAULT_LLM_API_KEY") or keychain_get(KEYCHAIN_LLM_ACCOUNT)
    return s
