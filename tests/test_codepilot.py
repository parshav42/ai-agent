from fastapi.testclient import TestClient

from vs_code.app import app
from vs_code.config import Settings


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("CODEPILOT_MODEL_PROVIDER", "ollama")
    monkeypatch.setenv("CODEPILOT_MODEL", "gemma3:2b")
    monkeypatch.setenv("CODEPILOT_BASE_URL", "http://localhost:9999")
    monkeypatch.setenv("CODEPILOT_TEMPERATURE", "0.7")
    monkeypatch.setenv("CODEPILOT_MAX_CONTEXT", "2048")
    monkeypatch.setenv("CODEPILOT_CONNECTION_TIMEOUT", "15")

    settings = Settings.from_env()

    assert settings.provider == "ollama"
    assert settings.model == "gemma3:2b"
    assert settings.base_url == "http://localhost:9999"
    assert settings.temperature == 0.7
    assert settings.max_context == 2048
    assert settings.connection_timeout == 15.0


def test_health_endpoint():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] in {"ollama", "openai_compatible"}
    assert "ok" in payload


def test_chat_endpoint_accepts_messages():
    client = TestClient(app)
    payload = {
        "messages": [{"role": "user", "content": "hello"}],
        "model": "qwen3:1.7b",
    }
    response = client.post("/chat", json=payload)
    assert response.status_code in {200, 502}
    if response.status_code == 200:
        body = response.json()
        assert "message" in body
        assert body["message"]["role"] == "assistant"
