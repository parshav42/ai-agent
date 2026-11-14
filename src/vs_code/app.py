from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .config import get_settings
from .providers import get_provider


class ChatMessage(BaseModel):
    role: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str | None = None
    temperature: float | None = None
    max_context: int | None = None


Settings = get_settings()


def create_app() -> FastAPI:
    app = FastAPI(title="CodePilot", version="0.1.0")

    @app.get("/")
    async def root() -> dict[str, Any]:
        return {
            "name": "CodePilot",
            "provider": Settings.provider,
            "model": Settings.model,
            "status": "ready",
        }

    @app.get("/health")
    async def health() -> dict[str, Any]:
        provider = get_provider(Settings)
        try:
            return provider.health()
        except Exception as exc:  # pragma: no cover - network issues are expected in offline mode
            return {"ok": False, "provider": Settings.provider, "error": str(exc), "available_models": []}

    @app.get("/models")
    async def models() -> dict[str, Any]:
        provider = get_provider(Settings)
        try:
            return {"models": provider.list_models()}
        except Exception as exc:  # pragma: no cover - network issues are expected in offline mode
            return {"models": [], "error": str(exc)}

    @app.post("/chat")
    async def chat(request: ChatRequest) -> dict[str, Any]:
        provider = get_provider(Settings)
        try:
            response = provider.chat(
                [message.model_dump() for message in request.messages],
                model=request.model or Settings.model,
                temperature=request.temperature,
                max_context=request.max_context,
            )
            return {"model": response.get("model"), "message": {"role": response.get("role", "assistant"), "content": response.get("content", "")}}
        except Exception as exc:  # pragma: no cover - make network failures visible to clients
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return app


app = create_app()
