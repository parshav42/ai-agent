from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

ProviderName = Literal["ollama", "openai_compatible"]


@dataclass(frozen=True)
class Settings:
    provider: ProviderName = "ollama"
    model: str = "qwen3:1.7b"
    base_url: str = "http://localhost:11434"
    temperature: float = 0.2
    max_context: int = 4096
    connection_timeout: float = 120.0
    api_key: str = "dummy"

    @classmethod
    def from_env(cls) -> "Settings":
        provider = os.getenv("CODEPILOT_MODEL_PROVIDER", "ollama")
        if provider not in {"ollama", "openai_compatible"}:
            raise ValueError(f"Unsupported CODEPILOT_MODEL_PROVIDER: {provider}")

        model = os.getenv("CODEPILOT_MODEL", "qwen3:1.7b")
        base_url = os.getenv("CODEPILOT_BASE_URL", "http://localhost:11434")
        temperature = float(os.getenv("CODEPILOT_TEMPERATURE", "0.2"))
        max_context = int(os.getenv("CODEPILOT_MAX_CONTEXT", "4096"))
        connection_timeout = float(os.getenv("CODEPILOT_CONNECTION_TIMEOUT", "120.0"))
        api_key = os.getenv("CODEPILOT_API_KEY", "dummy")

        return cls(
            provider=provider,
            model=model,
            base_url=base_url,
            temperature=temperature,
            max_context=max_context,
            connection_timeout=connection_timeout,
            api_key=api_key,
        )


_settings = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings
