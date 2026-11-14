from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, Iterable

import httpx

from .config import Settings


class ModelProvider(ABC):
    def __init__(self, settings: Settings):
        self.settings = settings

    @abstractmethod
    def health(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def list_models(self) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def chat(
        self,
        messages: Iterable[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_context: int | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError


class OllamaProvider(ModelProvider):
    def health(self) -> dict[str, Any]:
        try:
            response = httpx.get(
                f"{self.settings.base_url.rstrip('/')}/api/version",
                timeout=self.settings.connection_timeout,
            )
            response.raise_for_status()
            payload = response.json()
            return {"ok": True, "provider": "ollama", "version": payload.get("version")}
        except Exception as exc:  # pragma: no cover - offline environment is expected in CI
            return {"ok": False, "provider": "ollama", "error": str(exc), "available_models": []}

    def list_models(self) -> list[str]:
        try:
            response = httpx.get(
                f"{self.settings.base_url.rstrip('/')}/api/tags",
                timeout=self.settings.connection_timeout,
            )
            response.raise_for_status()
            payload = response.json()
            models = payload.get("models", [])
            return [model.get("name", "") for model in models if model.get("name")]
        except Exception:
            return []

    def chat(
        self,
        messages: Iterable[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_context: int | None = None,
    ) -> dict[str, Any]:
        payload = {
            "model": model or self.settings.model,
            "messages": list(messages),
            "stream": False,
            "options": {
                "temperature": temperature if temperature is not None else self.settings.temperature,
                "num_ctx": max_context if max_context is not None else self.settings.max_context,
            },
        }
        response = httpx.post(
            f"{self.settings.base_url.rstrip('/')}/api/chat",
            json=payload,
            timeout=self.settings.connection_timeout,
        )
        response.raise_for_status()
        data = response.json()
        message = data.get("message") or {}
        text = message.get("content") or ""
        return {"role": message.get("role", "assistant"), "content": text, "model": payload["model"]}


class OpenAICompatibleProvider(ModelProvider):
    def __init__(self, settings: Settings):
        super().__init__(settings)
        import openai

        self.client = openai.OpenAI(
            api_key=settings.api_key,
            base_url=settings.base_url,
            timeout=settings.connection_timeout,
        )

    def health(self) -> dict[str, Any]:
        try:
            models = self.list_models()
            return {"ok": True, "provider": "openai_compatible", "models": models}
        except Exception as exc:  # pragma: no cover - failure is surfaced to caller
            return {"ok": False, "provider": "openai_compatible", "error": str(exc)}

    def list_models(self) -> list[str]:
        response = self.client.models.list()
        return [model.id for model in response.data]

    def chat(
        self,
        messages: Iterable[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_context: int | None = None,
    ) -> dict[str, Any]:
        response = self.client.chat.completions.create(
            model=model or self.settings.model,
            messages=list(messages),
            temperature=temperature if temperature is not None else self.settings.temperature,
            max_tokens=max_context or None,
        )
        choice = response.choices[0]
        message = choice.message
        return {"role": message.role, "content": message.content or "", "model": model or self.settings.model}


def get_provider(settings: Settings) -> ModelProvider:
    if settings.provider == "ollama":
        return OllamaProvider(settings)
    if settings.provider == "openai_compatible":
        return OpenAICompatibleProvider(settings)
    raise ValueError(f"Unsupported provider: {settings.provider}")
