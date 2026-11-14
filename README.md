# CodePilot

A local-first AI coding assistant with a FastAPI backend and a VS Code extension. The extension adds bounded workspace source context to chat requests; Ollama and OpenAI-compatible providers remain behind the existing backend abstraction.

## Features

- Environment-driven configuration via `CODEPILOT_*` variables
- Provider abstraction with support for `ollama` and `openai_compatible`
- Health and model listing endpoints
- Chat endpoint for local inference
- VS Code CodePilot activity-bar chat with current-file and selection attachments
- Workspace file listing, filename/content search, file reading, and function/class/import/reference lookup
- Bounded context with source path/line references, configurable ignored paths, and sensitive-file exclusions
- Local conversation and context-attachment persistence

## Quick start

1. Start Ollama locally and ensure a model like `qwen3:1.7b` is available.
2. Export any configuration you need:

   ```bash
   export CODEPILOT_MODEL_PROVIDER=ollama
   export CODEPILOT_MODEL=qwen3:1.7b
   export CODEPILOT_BASE_URL=http://localhost:11434
   export CODEPILOT_TEMPERATURE=0.2
   export CODEPILOT_MAX_CONTEXT=4096
   ```

3. Install and run the backend:

   ```bash
   .venv/bin/uv pip install -e .
   .venv/bin/python main.py
   ```

4. Open this folder in VS Code, install extension dependencies, and compile:

   ```bash
   npm install
   npm run compile
   ```

   Press `F5` to launch an Extension Development Host, then open the CodePilot activity-bar view. Configure `codepilot.backendUrl`, `codepilot.defaultModel`, or `codepilot.ignoredPaths` in VS Code Settings as needed. Use **Add Current File** or **Add Selection** to attach explicit editor context; otherwise CodePilot searches a bounded set of relevant workspace files for each question.

5. Run checks:

   ```bash
   PYTHONPATH=src .venv/bin/python -m pytest -q
   npm test
   ```

6. Or call the backend API directly:

   ```bash
   curl http://localhost:8000/health
   curl -X POST http://localhost:8000/chat \
     -H 'Content-Type: application/json' \
     -d '{"messages":[{"role":"user","content":"Hello from CodePilot"}]}'
   ```

Workspace discovery is lexical and bounded (currently up to 250 candidate files, 256 KiB per file, and 7,500 context characters). Function/class/import detection uses lightweight source patterns rather than language-server semantic analysis. Chat streaming and autonomous file edits are not implemented in this phase.
