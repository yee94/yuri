import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import * as core from './assistants-core';
import * as model from './model';
import { bindRequest } from './runtime';
import { createHost } from './tests/assistants-settings-host.js';

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('nsh', () => ({ host: { available: () => true, call: h.call } }));
const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
function production(file: string, name: string, ports: Record<string, unknown>, observations?: string) {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration?.body) throw new Error('Missing production controller ' + name);
  const body = declaration.body.statements.filter(node => !observations || !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const output = ts.transpileModule(`function ${name}(${declaration.parameters.map(node => node.getText(source)).join(', ')}) { ${body}; ${observations ? `return { ${observations} };` : ''} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(ports), `${output}; return ${name};`)(...Object.values(ports));
}
function fixture() {
  const host = createHost(), snapshot = host.call('connection.list', {}), scope = snapshot.runtimeScope;
  h.call.mockReset(); h.call.mockImplementation((name, input) => host.call(name, input));
  const send = bindRequest(scope), cleanups: Array<() => void> = [];
  const signal = <T>(value: T) => Object.assign(() => value, { set(next: T) { value = next; } });
  const currentScope = signal(scope), connection = snapshot.connections.find(entry => entry.id === snapshot.selected);
  const captureHostOperation = () => {
    const captured = currentScope();
    return { scope: captured, generation: 1, current: () => currentScope() === captured, request: bindRequest(captured) };
  };
  const dialog = vi.fn(async () => ({ action: 'cancel' }));
  const ports = { ...core, ...model, signal, captureHostOperation, epoch: () => 1,
    app: { connection: () => connection, runtimeScope: currentScope }, lifecycle: () => 'active',
    effect: (work: () => unknown) => { const dispose = work(); if (typeof dispose === 'function') cleanups.push(dispose as () => void); },
    cleanup: (work: () => void) => cleanups.push(work), untracked: (work: () => unknown) => work(),
    t: (key: string) => key, AlertDialog: { show: dialog },
  };
  const createPageOperations = production('page-operations.ts', 'createPageOperations', ports), cleared = vi.fn();
  const owner = production('assistants-details.tsx', 'AssistantDetails', { ...ports, createPageOperations }, 'clearHistory, clearing, historyNotice, historyError')({
    bot: { id: 'bot/a' }, active: true, onDone() {}, onHistoryCleared: cleared,
    historyActions: { clearLabel: 'Clear chat history', confirmDescription: 'Synthetic confirmation', clearedLabel: 'Chat history cleared' },
  });
  return { host, send, owner, dialog, cleared, dispose: () => cleanups.reverse().forEach(work => work()) };
}

it('real reset ACK clears the UI only after explicit confirmation, with cancel zero writes and one successful reset', async () => {
  const f = fixture();
  try {
    await flush(); await f.owner.clearHistory();
    expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ clearAttempts: 0, contactReads: 0 });
    expect(f.cleared).not.toHaveBeenCalled(); expect(f.owner.historyNotice()).toBe('');
    f.dialog.mockResolvedValue({ action: 'clear' }); await f.owner.clearHistory(); await flush();
    expect(f.owner.historyNotice()).toBe('Chat history cleared'); expect(f.owner.historyError()).toBe('');
    expect(f.cleared).toHaveBeenCalledExactlyOnceWith('bot/a', 2);
    expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ clearAttempts: 1, contactReads: 0 });
    const posts = h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.method === 'POST');
    expect(posts).toHaveLength(1); expect(posts[0][1].path).toBe('/api/yuri/assistants/bot%2Fa/contact/reset'); expect(posts[0][1].body).toBeUndefined();
  } finally { f.dispose(); }
});

it.each(['unknown', 'unknown-read-failed'] as const)('%s reset retains uncertainty across explicit GET retries without replaying POST or declaring success', async mode => {
  const f = fixture();
  try {
    await flush(); await f.send('/fixture/assistants-settings/reset-scenario', 'PUT', { mode });
    f.dialog.mockResolvedValue({ action: 'clear' });
    await f.owner.clearHistory(); expect(f.owner.historyError()).toBe('HTTP 500: fixture_clear_failed');
    expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ clearAttempts: 1, contactReads: 0 });
    await f.owner.clearHistory(); await f.owner.clearHistory();
    expect(f.dialog).toHaveBeenCalledTimes(1);
    expect(f.owner.historyNotice()).toBe(''); expect(f.cleared).not.toHaveBeenCalled(); expect(f.owner.clearing()).toBe(false);
    expect(f.owner.historyError()).toBe(mode === 'unknown' ? 'assistants.state.unavailable' : 'HTTP 503: fixture_contact_read_failed');
    expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ clearAttempts: 1, contactReads: 2 });
    const posts = h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path.endsWith('/contact/reset') && input.method === 'POST');
    expect(posts).toHaveLength(1);
    const reads = h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path.includes('/contact/messages'));
    expect(reads).toHaveLength(2); expect(reads.every(([, input]) => input.method === 'GET' && input.path === '/api/yuri/assistants/bot%2Fa/contact/messages?limit=1' && input.body === undefined)).toBe(true);
  } finally { f.dispose(); }
});
