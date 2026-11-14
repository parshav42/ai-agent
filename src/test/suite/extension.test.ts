import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextBuilder, makeAttachedContext, WorkspaceExplorer } from '../../workspace';

suite('CodePilot Extension', () => {
  test('extension activates and exposes commands', async () => {
    const extension = vscode.extensions.getExtension('codepilot.codepilot');
    assert.ok(extension, 'expected CodePilot extension to be registered');
    await extension?.activate();

    const openCommand = await vscode.commands.getCommands(true);
    assert.ok(openCommand.includes('codepilot.open'));
    assert.ok(openCommand.includes('codepilot.newConversation'));
    assert.ok(openCommand.includes('codepilot.addCurrentFile'));
    assert.ok(openCommand.includes('codepilot.addSelection'));
    assert.ok(openCommand.includes('codepilot.searchWorkspace'));
    assert.ok(openCommand.includes('codepilot.searchFileNames'));
    assert.ok(openCommand.includes('codepilot.findFunctions'));
    assert.ok(openCommand.includes('codepilot.findClasses'));
    assert.ok(openCommand.includes('codepilot.findImports'));
    assert.ok(openCommand.includes('codepilot.findReferences'));
  });

  test('workspace settings are present', () => {
    const config = vscode.workspace.getConfiguration('codepilot');
    assert.strictEqual(config.get('backendUrl'), 'http://localhost:8000');
    assert.strictEqual(config.get('defaultModel'), 'qwen3:1.7b');
    assert.deepStrictEqual(config.get('ignoredPaths'), []);
  });

  test('workspace discovery, search, symbols, and reads stay within safe files', async () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root, 'test requires a workspace folder');
    const fixtureDir = fs.mkdtempSync(path.join(root.uri.fsPath, '.codepilot-test-'));
    const fixturePath = path.join(fixtureDir, 'service.py');
    fs.writeFileSync(fixturePath, [
      'from fastapi import FastAPI',
      'class BillingService:',
      '    def charge_customer(self, customer_id):',
      '        return customer_id',
      '',
      'def create_app():',
      '    return BillingService()',
    ].join('\n'));
    fs.writeFileSync(path.join(fixtureDir, '.env'), 'TOKEN=must-not-read');
    fs.mkdirSync(path.join(fixtureDir, 'node_modules'));
    fs.writeFileSync(path.join(fixtureDir, 'node_modules', 'private.js'), 'sensitiveToken');
    fs.mkdirSync(path.join(fixtureDir, 'ignored'));
    fs.writeFileSync(path.join(fixtureDir, 'ignored', 'ignored.py'), 'ignoredMarker');
    fs.writeFileSync(path.join(fixtureDir, 'oversized.py'), 'x'.repeat(256 * 1024 + 1));
    fs.symlinkSync('/etc/passwd', path.join(fixtureDir, 'outside-link.txt'));

    try {
      const explorer = new WorkspaceExplorer(root, ['**/ignored/**']);
      const files = await explorer.listFiles(2000);
      assert.ok(files.some((file) => file.endsWith('/service.py')));
      assert.ok(!files.some((file) => file.endsWith('/.env')));
      assert.ok(!files.some((file) => file.includes('node_modules')));
      assert.ok(!files.some((file) => file.includes('/ignored/')));

      const contents = await explorer.readFile(path.relative(root.uri.fsPath, fixturePath));
      assert.match(contents.content, /charge_customer/);
      assert.strictEqual(contents.language, 'python');

      const names = await explorer.searchFileNames('service');
      assert.ok(names.some((file) => file.endsWith('/service.py')));
      const matches = await explorer.searchFileContents('charge_customer');
      assert.ok(matches.some((match) => match.path.endsWith('/service.py') && match.line === 3));
      const functions = await explorer.findDefinitions('function');
      assert.ok(functions.some((match) => match.text.includes('charge_customer')));
      const classes = await explorer.findDefinitions('class');
      assert.ok(classes.some((match) => match.text.includes('BillingService')));
      const imports = await explorer.findDefinitions('import');
      assert.ok(imports.some((match) => match.text.includes('fastapi')));
      const references = await explorer.findReferences('BillingService');
      assert.ok(references.length >= 2);

      await assert.rejects(() => explorer.readFile('../outside-secret.txt'), /outside the current workspace/i);
      await assert.rejects(() => explorer.readFile(path.relative(root.uri.fsPath, path.join(fixtureDir, '.env'))), /excluded/i);
      await assert.rejects(() => explorer.readFile(path.relative(root.uri.fsPath, path.join(fixtureDir, 'node_modules', 'private.js'))), /excluded/i);
      await assert.rejects(() => explorer.readFile(path.relative(root.uri.fsPath, path.join(fixtureDir, 'ignored', 'ignored.py'))), /excluded/i);
      await assert.rejects(() => explorer.readFile(path.relative(root.uri.fsPath, path.join(fixtureDir, 'oversized.py'))), /context limit/i);
      await assert.rejects(() => explorer.readFile(path.relative(root.uri.fsPath, path.join(fixtureDir, 'outside-link.txt'))), /outside the current workspace/i);
      await assert.rejects(() => explorer.findReferences('../secret'), /valid symbol/i);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('context builder uses selected code, cites paths and lines, and enforces a size cap', async () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root, 'test requires a workspace folder');
    const fixtureDir = fs.mkdtempSync(path.join(root.uri.fsPath, '.codepilot-context-'));
    const fixturePath = path.join(fixtureDir, 'payments.py');
    fs.writeFileSync(fixturePath, 'def process_invoice(invoice_id):\n    return invoice_id\n');

    try {
      const uri = vscode.Uri.file(fixturePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const explorer = new WorkspaceExplorer(root);
      const selectedRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 21));
      const selection = makeAttachedContext('selection', document, document.getText(selectedRange), 1, new vscode.Position(0, 5));
      const context = await new ContextBuilder(explorer, 1800).build('Explain this code', [selection]);
      assert.ok(context.prompt.includes('Selected code'));
      assert.ok(context.prompt.includes('payments.py:1'));
      assert.ok(context.prompt.includes('cursor 1:6'));
      assert.ok(context.prompt.includes('process_invoice'));
      assert.ok(context.prompt.length <= 1800);
      assert.ok(context.fileCount >= 1);

      const bounded = await new ContextBuilder(explorer, 1000).build('Explain process_invoice', [selection]);
      assert.ok(bounded.prompt.length <= 1000);

      const attachedFile = makeAttachedContext('file', document, document.getText(), 1);
      const fileContext = await new ContextBuilder(explorer).build('Explain this file', [attachedFile]);
      assert.ok(fileContext.prompt.includes('Attached file:'));
      assert.ok(fileContext.prompt.includes('payments.py:1'));
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('architecture questions include bounded repository entry-point evidence', async () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root, 'test requires a workspace folder');
    const explorer = new WorkspaceExplorer(root);
    const workspaceFiles = await explorer.listFiles(2000);
    const result = await new ContextBuilder(explorer).build('Explain the architecture of this project');
    assert.ok(result.prompt.includes('README.md'), `Workspace root ${root.uri.fsPath}; found ${workspaceFiles.filter((file) => /readme/i.test(file)).join(', ') || 'no README path'}`);
    assert.ok(result.prompt.includes('pyproject.toml'));
    assert.match(result.prompt, /README\.md:\d+/);
    assert.ok(result.prompt.length <= 7500);
    assert.ok(result.fileCount > 0);
  });
});
