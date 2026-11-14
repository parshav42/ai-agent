import * as vscode from 'vscode';
import { AttachedContext, ContextBuilder, makeAttachedContext, WorkspaceExplorer } from './workspace';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  role: ChatRole;
  content: string;
  timestamp: number;
};

type ProviderState = {
  backendUrl: string;
  model: string;
  models: string[];
  messages: ChatMessage[];
  status: 'connected' | 'disconnected' | 'loading' | 'error';
  error?: string;
  attachedContext: AttachedContext[];
  contextSummary: string;
};

const CONVERSATION_KEY = 'codepilot.conversation';
const MODELS_KEY = 'codepilot.models';
const MODEL_KEY = 'codepilot.model';
const BACKEND_URL_KEY = 'codepilot.backendUrl';
const CONTEXT_KEY = 'codepilot.attachedContext';

class CodePilotViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _pendingRequest?: AbortController;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: any) => {
      switch (message.type) {
        case 'ready':
          await this.publishState();
          break;
        case 'loadModels':
          await this.loadModels();
          break;
        case 'setBackendUrl':
          await this.updateBackendUrl(message.backendUrl);
          break;
        case 'setModel':
          this.updateSelectedModel(message.model);
          await this.publishState();
          break;
        case 'sendMessage':
          await this.sendMessage(message.text);
          break;
        case 'retryLast':
          await this.retryLastMessage();
          break;
        case 'clearConversation':
          this.clearConversation();
          await this.publishState();
          break;
        case 'stopGeneration':
          this.stopGeneration();
          break;
        case 'attachCurrentFile':
          await this.attachCurrentFile();
          break;
        case 'attachSelection':
          await this.attachSelection();
          break;
        case 'removeContext':
          await this.removeContext(message.id);
          break;
        default:
          break;
      }
    });
  }

  private getSettings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('codepilot');
  }

  private getBackendUrl(): string {
    return this.context.globalState.get<string>(BACKEND_URL_KEY, this.getSettings().get<string>('backendUrl', 'http://localhost:8000'));
  }

  private setBackendUrl(url: string): void {
    this.context.globalState.update(BACKEND_URL_KEY, url);
    this.getSettings().update('backendUrl', url, vscode.ConfigurationTarget.Global);
  }

  private getSelectedModel(): string {
    return this.context.globalState.get<string>(MODEL_KEY, this.getSettings().get<string>('defaultModel', 'qwen3:1.7b'));
  }

  private updateSelectedModel(model: string): void {
    this.context.globalState.update(MODEL_KEY, model);
    this.getSettings().update('defaultModel', model, vscode.ConfigurationTarget.Global);
  }

  private getConversation(): ChatMessage[] {
    return this.context.globalState.get<ChatMessage[]>(CONVERSATION_KEY, []);
  }

  private setConversation(messages: ChatMessage[]): Thenable<void> {
    return this.context.globalState.update(CONVERSATION_KEY, messages);
  }

  private async publishState(): Promise<void> {
    if (!this._view) {
      return;
    }

    const state: ProviderState = {
      backendUrl: this.getBackendUrl(),
      model: this.getSelectedModel(),
      models: this.context.globalState.get<string[]>(MODELS_KEY, []),
      messages: this.getConversation(),
      status: this._pendingRequest ? 'loading' : 'connected',
      attachedContext: this.getAttachedContext(),
      contextSummary: this.contextSummary(),
    };

    this._view.webview.postMessage({ type: 'state', payload: state });
  }

  private async updateBackendUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }

    this.setBackendUrl(trimmed);
    await this.loadModels();
    await this.publishState();
  }

  private async loadModels(): Promise<void> {
    const backendUrl = this.getBackendUrl();
    const url = new URL('/models', backendUrl).toString();

    try {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const payload = await response.json() as { models?: string[]; error?: string };
      const models = Array.isArray(payload.models) ? payload.models : [];
      this.context.globalState.update(MODELS_KEY, models);

      if (models.length > 0 && !models.includes(this.getSelectedModel())) {
        this.updateSelectedModel(models[0]);
      }
      await this.publishState();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown backend error';
      this.context.globalState.update(MODELS_KEY, []);
      if (this._view) {
        this._view.webview.postMessage({ type: 'error', message: `Unable to load models: ${message}` });
      }
    }
  }

  private stopGeneration(): void {
    this._pendingRequest?.abort();
    this._pendingRequest = undefined;
    void this.publishState();
  }

  private async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const nextHistory = [...this.getConversation(), { role: 'user' as const, content: trimmed, timestamp: Date.now() }];
    await this.setConversation(nextHistory);
    this._pendingRequest = new AbortController();
    await this.publishState();

    try {
      const backendUrl = this.getBackendUrl();
      const builder = this.getContextBuilder();
      const context = builder
        ? await builder.build(trimmed, this.getAttachedContext(), await this.getVisibleWorkspaceFiles())
        : {
          prompt: 'You are CodePilot. No VS Code workspace is open. Answer only from the conversation and be explicit about missing project evidence.',
          fileCount: 0,
          snippetCount: 0,
        };
      this._view?.webview.postMessage({
        type: 'contextSummary',
        summary: `${context.fileCount} relevant files, ${context.snippetCount} code snippets`,
      });
      const response = await fetch(new URL('/chat', backendUrl).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.getSelectedModel(),
          messages: [
            { role: 'system', content: context.prompt },
            ...this.boundedHistory(nextHistory).map((message) => ({ role: message.role, content: message.content })),
          ],
        }),
        signal: this._pendingRequest.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Request failed with status ${response.status}`);
      }

      const payload = await response.json() as { message?: { role?: string; content?: string } };
      const assistantMessage = payload.message?.content ?? 'No response returned';
      const updatedHistory = [...nextHistory, { role: 'assistant' as const, content: assistantMessage, timestamp: Date.now() }];
      await this.setConversation(updatedHistory);
      await this.publishState();
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        await this.publishState();
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown connection error';
      const updatedHistory = [...nextHistory, { role: 'assistant' as const, content: `Error: ${message}`, timestamp: Date.now() }];
      await this.setConversation(updatedHistory);
      if (this._view) {
        this._view.webview.postMessage({ type: 'error', message: `Connection error: ${message}` });
      }
      await this.publishState();
    } finally {
      this._pendingRequest = undefined;
    }
  }

  private async retryLastMessage(): Promise<void> {
    const history = this.getConversation();
    if (history.length === 0) {
      return;
    }

    const lastUserIndex = [...history].reverse().findIndex((message) => message.role === 'user');
    if (lastUserIndex === -1) {
      return;
    }

    const start = history.length - 1 - lastUserIndex;
    const retryPrompt = history[start]?.content;
    if (!retryPrompt) {
      return;
    }

    const trimmedHistory = history.slice(0, start);
    await this.setConversation(trimmedHistory);
    await this.sendMessage(retryPrompt);
  }

  private clearConversation(): void {
    this._pendingRequest?.abort();
    this._pendingRequest = undefined;
    void this.setConversation([]);
  }

  private getAttachedContext(): AttachedContext[] {
    return this.context.globalState.get<AttachedContext[]>(CONTEXT_KEY, []);
  }

  private async setAttachedContext(items: AttachedContext[]): Promise<void> {
    await this.context.globalState.update(CONTEXT_KEY, items);
  }

  private getContextBuilder(): ContextBuilder | undefined {
    const explorer = WorkspaceExplorer.fromActiveWorkspace();
    return explorer ? new ContextBuilder(explorer) : undefined;
  }

  private async getVisibleWorkspaceFiles(): Promise<string[]> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return [];
    }
    const explorer = WorkspaceExplorer.fromActiveWorkspace();
    if (!explorer) {
      return [];
    }
    const files: string[] = [];
    for (const editor of vscode.window.visibleTextEditors) {
      try {
        files.push((await explorer.readFile(vscode.workspace.asRelativePath(editor.document.uri, false))).path);
      } catch {
        continue;
      }
    }
    return [...new Set(files)].slice(0, 8);
  }

  private contextSummary(): string {
    const attachedCount = this.getAttachedContext().length;
    return attachedCount
      ? `${attachedCount} attached item${attachedCount === 1 ? '' : 's'}; related files are searched automatically.`
      : 'No files attached; related workspace files are searched automatically.';
  }

  private async attachCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open a file before attaching it to CodePilot.');
      return;
    }
    const explorer = WorkspaceExplorer.fromActiveWorkspace();
    if (!explorer) {
      vscode.window.showWarningMessage('Open a workspace folder before attaching files.');
      return;
    }
    try {
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      const file = await explorer.readFile(relativePath);
      const attached = this.getAttachedContext().filter((item) => item.path !== file.path || item.kind !== 'file');
      attached.push(makeAttachedContext('file', editor.document, file.content, 1, editor.selection.active));
      await this.setAttachedContext(attached);
      await this.publishState();
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to attach current file.');
    }
  }

  private async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('Select code in the active editor before attaching it.');
      return;
    }
    const explorer = WorkspaceExplorer.fromActiveWorkspace();
    if (!explorer) {
      vscode.window.showWarningMessage('Open a workspace folder before attaching a selection.');
      return;
    }
    try {
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      await explorer.readFile(relativePath);
      const startLine = editor.selection.start.line + 1;
      const context = makeAttachedContext('selection', editor.document, editor.document.getText(editor.selection), startLine, editor.selection.active);
      const attached = this.getAttachedContext().filter((item) => item.id !== context.id);
      attached.push(context);
      await this.setAttachedContext(attached);
      await this.publishState();
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to attach selected code.');
    }
  }

  private async removeContext(id: string): Promise<void> {
    await this.setAttachedContext(this.getAttachedContext().filter((item) => item.id !== id));
    await this.publishState();
  }

  private boundedHistory(messages: ChatMessage[]): ChatMessage[] {
    let remaining = 2500;
    const result: ChatMessage[] = [];
    for (const message of [...messages].reverse()) {
      if (remaining <= 0) {
        break;
      }
      const content = message.content.slice(-remaining);
      result.unshift({ ...message, content });
      remaining -= content.length;
    }
    return result;
  }

  private getHtml(webview: vscode.Webview): string {
    const state = {
      backendUrl: this.getBackendUrl(),
      model: this.getSelectedModel(),
      models: this.context.globalState.get<string[]>(MODELS_KEY, []),
      messages: this.getConversation(),
      attachedContext: this.getAttachedContext(),
      contextSummary: this.contextSummary(),
    };

    const nonce = this.getNonce();
    const serializedState = JSON.stringify(state).replace(/</g, '\\u003c');
    const backendUrlAttribute = state.backendUrl
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>CodePilot</title>
        <style>
          :root {
            color-scheme: light dark;
            --bg: var(--vscode-sideBar-background);
            --panel: var(--vscode-editor-background);
            --panel-alt: var(--vscode-input-background);
            --border: var(--vscode-panel-border);
            --text: var(--vscode-foreground);
            --muted: var(--vscode-descriptionForeground);
            --assistant: var(--vscode-textBlockQuote-background);
            --user: var(--vscode-button-secondaryBackground);
            --accent: var(--vscode-focusBorder);
            --danger: #fda4af;
            --shadow: rgba(15, 23, 42, 0.25);
          }
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            height: 100%;
            background: var(--bg);
            color: var(--text);
            font-family: var(--vscode-font-family), sans-serif;
          }
          body { display: flex; flex-direction: column; padding: 12px; gap: 12px; }
          .toolbar {
            display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
            padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel);
          }
          .toolbar label { font-size: 11px; color: var(--muted); }
          .toolbar input, .toolbar select, textarea, button {
            border-radius: 8px; border: 1px solid var(--border); background: var(--panel-alt); color: var(--text);
            font: inherit; padding: 8px 10px;
          }
          input, select, textarea { width: 100%; }
          .status-pill {
            display: inline-flex; align-items: center; padding: 5px 8px; border-radius: 999px; font-size: 11px;
            background: var(--vscode-testing-iconPassed, #22c55e); color: var(--vscode-button-foreground, #fff); border: 1px solid var(--border);
          }
          .status-pill.error { background: rgba(248, 113, 113, 0.18); color: #fecaca; border-color: rgba(248, 113, 113, 0.3); }
          .status-pill.loading { background: rgba(59, 130, 246, 0.18); color: #bfdbfe; border-color: rgba(59, 130, 246, 0.3); }
          .messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 2px 2px 8px; }
          .message {
            border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: rgba(255,255,255,0.02);
            white-space: pre-wrap; line-height: 1.5; font-size: 13px;
          }
          .message.user { background: var(--user); }
          .message.assistant { background: var(--assistant); }
          .message-header { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
          .message-body { overflow-wrap: anywhere; }
          .message-body code {
            background: var(--vscode-textCodeBlock-background); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; font-family: var(--vscode-editor-font-family), monospace;
          }
          .message-body pre { margin: 8px 0; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--border); padding: 8px; border-radius: 8px; overflow-x: auto; }
          .message-body pre code { background: transparent; border: none; padding: 0; }
          .composer { display: flex; gap: 8px; flex-direction: column; }
          .composer textarea { min-height: 80px; resize: vertical; }
          .actions { display: flex; gap: 8px; flex-wrap: wrap; }
          button {
            cursor: pointer; transition: opacity 0.2s ease; }
          button:hover { opacity: 0.9; }
          .primary { background: rgba(56, 189, 248, 0.2); border-color: rgba(56, 189, 248, 0.5); }
          .danger { background: rgba(248, 113, 113, 0.14); border-color: rgba(248, 113, 113, 0.4); }
          .empty-state { color: var(--muted); font-size: 12px; text-align: center; padding: 16px 0; }
          .hidden { display: none; }
          .context-panel, .context-summary { color: var(--muted); font-size: 11px; }
          .context-item { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px; margin-top: 5px; }
          .context-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        </style>
      </head>
      <body>
        <div class="toolbar">
          <div class="status-pill" id="statusPill">connected</div>
          <label for="backendUrlInput">Backend</label>
          <input id="backendUrlInput" type="text" value="${backendUrlAttribute}" />
          <label for="modelSelect">Model</label>
          <select id="modelSelect"></select>
        </div>
        <div class="actions">
          <button id="attachFileButton" type="button">Add Current File</button>
          <button id="attachSelectionButton" type="button">Add Selection</button>
        </div>
        <div id="contextPanel" class="context-panel"></div>
        <div id="contextSummary" class="context-summary"></div>
        <div id="messages" class="messages"></div>
        <div class="composer">
          <textarea id="promptInput" placeholder="Ask CodePilot to inspect, plan, and build..."></textarea>
          <div class="actions">
            <button class="primary" id="sendButton" type="button">Send</button>
            <button id="retryButton" type="button">Retry last</button>
            <button class="danger" id="clearButton" type="button">Clear</button>
            <button class="danger" id="stopButton" type="button">Stop</button>
          </div>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const state = ${serializedState};
          const messageList = document.getElementById('messages');
          const backendUrlInput = document.getElementById('backendUrlInput');
          const modelSelect = document.getElementById('modelSelect');
          const promptInput = document.getElementById('promptInput');
          const statusPill = document.getElementById('statusPill');
          const sendButton = document.getElementById('sendButton');
          const retryButton = document.getElementById('retryButton');
          const clearButton = document.getElementById('clearButton');
          const stopButton = document.getElementById('stopButton');
          const attachFileButton = document.getElementById('attachFileButton');
          const attachSelectionButton = document.getElementById('attachSelectionButton');
          const contextPanel = document.getElementById('contextPanel');
          const contextSummary = document.getElementById('contextSummary');

          function escapeHtml(value) {
            return value
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
          }

          function renderMarkdown(text) {
            return escapeHtml(text).replace(/\n/g, '<br>');
          }

          function renderMessages(messages) {
            if (!messages || messages.length === 0) {
              messageList.innerHTML = '<div class="empty-state">No conversation yet. Ask CodePilot to inspect or build something.</div>';
              return;
            }

            var html = [];
            for (var i = 0; i < messages.length; i++) {
              var message = messages[i];
              var label = message.role === 'user' ? 'You' : 'CodePilot';
              var time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              html.push('<div class="message ' + message.role + '"><div class="message-header"><span>' + label + '</span><span>' + time + '</span></div><div class="message-body">' + renderMarkdown(message.content) + '</div></div>');
            }
            messageList.innerHTML = html.join('');

            if (messages[messages.length - 1] && messages[messages.length - 1].role === 'assistant') {
              retryButton.classList.remove('hidden');
            } else {
              retryButton.classList.add('hidden');
            }
          }

          function renderModels(models, selectedModel) {
            var html = [];
            if (models && models.length) {
              for (var i = 0; i < models.length; i++) {
                var model = models[i];
                var selected = model === selectedModel ? ' selected' : '';
                html.push('<option value="' + model + '"' + selected + '>' + model + '</option>');
              }
            } else {
              html.push('<option value="' + selectedModel + '">' + selectedModel + '</option>');
            }
            modelSelect.innerHTML = html.join('');
          }

          function setStatus(type, detail) {
            statusPill.className = 'status-pill';
            if (type === 'error') {
              statusPill.classList.add('error');
            } else if (type === 'loading') {
              statusPill.classList.add('loading');
            }
            statusPill.textContent = detail || type;
          }

          function applyState(nextState) {
            state.backendUrl = nextState.backendUrl || state.backendUrl;
            state.model = nextState.model || state.model;
            state.models = nextState.models || state.models || [];
            state.messages = nextState.messages || state.messages || [];
            state.status = nextState.status || 'connected';
            state.attachedContext = nextState.attachedContext || [];
            state.contextSummary = nextState.contextSummary || '';
            backendUrlInput.value = state.backendUrl;
            renderModels(state.models, state.model);
            renderMessages(state.messages);
            setStatus(state.status === 'connected' ? 'connected' : state.status, state.status === 'connected' ? 'connected' : state.status);
            modelSelect.value = state.model;
            contextSummary.textContent = state.contextSummary;
            contextPanel.innerHTML = (state.attachedContext || []).map((item) =>
              '<div class="context-item"><span>' + escapeHtml(item.kind + ': ' + item.path) +
              '</span><button type="button" data-context-id="' + escapeHtml(item.id) + '">Remove</button></div>',
            ).join('');
            contextPanel.querySelectorAll('button[data-context-id]').forEach((button) => {
              button.addEventListener('click', () => vscode.postMessage({
                type: 'removeContext',
                id: button.getAttribute('data-context-id'),
              }));
            });
          }

          backendUrlInput.addEventListener('change', () => {
            const nextBackendUrl = backendUrlInput.value.trim();
            if (!nextBackendUrl) {
              return;
            }
            vscode.postMessage({ type: 'setBackendUrl', backendUrl: nextBackendUrl });
          });

          modelSelect.addEventListener('change', () => {
            vscode.postMessage({ type: 'setModel', model: modelSelect.value });
          });

          sendButton.addEventListener('click', () => {
            const text = promptInput.value.trim();
            if (!text) {
              return;
            }
            promptInput.value = '';
            vscode.postMessage({ type: 'sendMessage', text });
          });

          retryButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'retryLast' });
          });

          clearButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearConversation' });
          });

          stopButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'stopGeneration' });
          });
          attachFileButton.addEventListener('click', () => vscode.postMessage({ type: 'attachCurrentFile' }));
          attachSelectionButton.addEventListener('click', () => vscode.postMessage({ type: 'attachSelection' }));

          promptInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              sendButton.click();
            }
          });

          window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.type === 'state') {
              applyState(message.payload);
            }
            if (message.type === 'error') {
              setStatus('error', 'error');
            }
            if (message.type === 'contextSummary') {
              contextSummary.textContent = message.summary;
            }
          });

          applyState(state);
          vscode.postMessage({ type: 'ready' });
          vscode.postMessage({ type: 'loadModels' });
        </script>
      </body>
      </html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CodePilotViewProvider(context);
  const revealMatches = async (matches: Array<{ path: string; line: number; text: string }>): Promise<void> => {
    const items = matches.map((match) => ({
      label: `${match.path}:${match.line}`,
      description: match.text,
      path: match.path,
      line: match.line,
    }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Workspace source matches' });
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!selected || !root) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, selected.path));
    const editor = await vscode.window.showTextDocument(document);
    const line = Math.max(0, selected.line - 1);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0));
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codepilot.chatView', provider),
    vscode.commands.registerCommand('codepilot.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.codepilot');
    }),
    vscode.commands.registerCommand('codepilot.newConversation', async () => {
      provider['clearConversation']();
      await provider['publishState']();
    }),
    vscode.commands.registerCommand('codepilot.addCurrentFile', () => provider['attachCurrentFile']()),
    vscode.commands.registerCommand('codepilot.addSelection', () => provider['attachSelection']()),
    vscode.commands.registerCommand('codepilot.listWorkspaceFiles', async () => {
      const explorer = WorkspaceExplorer.fromActiveWorkspace();
      if (!explorer) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const files = await explorer.listFiles();
      const selected = await vscode.window.showQuickPick(files, { placeHolder: 'Workspace files; sensitive and ignored files are excluded' });
      if (selected) {
        await vscode.env.clipboard.writeText(selected);
      }
    }),
    vscode.commands.registerCommand('codepilot.searchWorkspace', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Search workspace source' });
      if (!query) {
        return;
      }
      const explorer = WorkspaceExplorer.fromActiveWorkspace();
      if (!explorer) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      await revealMatches(await explorer.searchFileContents(query, 100));
    }),
    vscode.commands.registerCommand('codepilot.searchFileNames', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Search workspace file names' });
      if (!query) {
        return;
      }
      const explorer = WorkspaceExplorer.fromActiveWorkspace();
      if (!explorer) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const paths = await explorer.searchFileNames(query, 100);
      const selected = await vscode.window.showQuickPick(paths, { placeHolder: 'Workspace file-name matches' });
      const root = vscode.workspace.workspaceFolders?.[0];
      if (selected && root) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, selected));
        await vscode.window.showTextDocument(document);
      }
    }),
    vscode.commands.registerCommand('codepilot.findFunctions', async () => {
      const explorer = WorkspaceExplorer.fromActiveWorkspace();
      if (!explorer) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      await revealMatches(await explorer.findDefinitions('function'));
    }),
    vscode.commands.registerCommand('codepilot.findClasses', async () => {
      const explorer = WorkspaceExplorer.fromActiveWorkspace();
      if (!explorer) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      await revealMatches(await explorer.findDefinitions('class'));
    }),
    vscode.commands.registerCommand('codepilot.findImports', async () => {
      const explorer = WorkspaceExplorer.fromActiveWorkspace();
      if (!explorer) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      await revealMatches(await explorer.findDefinitions('import'));
    }),
    vscode.commands.registerCommand('codepilot.findReferences', async () => {
      const symbol = await vscode.window.showInputBox({ prompt: 'Enter the function, class, or variable name' });
      if (!symbol) {
        return;
      }
      const explorer = WorkspaceExplorer.fromActiveWorkspace();
      if (!explorer) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      await revealMatches(await explorer.findReferences(symbol));
    }),
  );

  void provider['loadModels']();
}

export function deactivate(): void {
  // no-op
}
