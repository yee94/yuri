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

/** Execute the unchanged production function; only native/UI ports are replaced. */
function production(file: string, name: string, ports: Record<string, unknown>, observations?: string) {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration?.body) throw new Error('Missing production controller ' + name);
  const body = declaration.body.statements.filter(node => !observations || !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const output = ts.transpileModule(`function ${name}(${declaration.parameters.map(node => node.getText(source)).join(', ')}) { ${body}; ${observations ? `return { ${observations} };` : ''} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(ports), `${output}; return ${name};`)(...Object.values(ports));
}

it('production Feishu transfer adopts authoritative client/owner fields after a seeded GET, clears only the secret draft and saves once', async () => {
  const host = createHost(), snapshot = host.call('connection.list', {}), scope = snapshot.runtimeScope;
  h.call.mockImplementation((name, input) => host.call(name, input));
  const cleanups: Array<() => void> = [];
  const signal = <T>(value: T) => Object.assign(() => value, { set(next: T) { value = next; } });
  const currentScope = signal(scope), connection = snapshot.connections.find(entry => entry.id === snapshot.selected);
  const captureHostOperation = () => {
    const captured = currentScope();
    return { scope: captured, generation: 1, current: () => currentScope() === captured, request: bindRequest(captured) };
  };
  const ports = { ...core, ...model, signal, captureHostOperation, epoch: () => 1,
    app: { connection: () => connection, runtimeScope: currentScope }, lifecycle: () => 'active',
    effect: (work: () => unknown) => { const dispose = work(); if (typeof dispose === 'function') cleanups.push(dispose as () => void); },
    cleanup: (work: () => void) => cleanups.push(work), untracked: (work: () => unknown) => work(),
    t: (key: string) => key, wireLanguage: () => 'en', assistantQRSvg: () => '',
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
    AlertDialog: { show: async () => ({ action: 'transfer' }) },
  };
  const createPageOperations = production('page-operations.ts', 'createPageOperations', ports);
  const close = vi.fn();
  try {
    const owner = production('assistants-channels.tsx', 'ChannelPanel', { ...ports, createPageOperations }, 'load, transfer, clientID, ownerID, secret, state, save, busy')({ bot: { id: 'bot/a' }, provider: 'feishu', active: true, onClose: close });
    await flush(); await owner.load(); await flush();
    expect(owner.state()).toMatchObject({ configured: false, clientID: '', ownerID: '', transferSources: [{ assistantID: 'other', revision: 'r1' }] });
    owner.secret.set('unsaved-synthetic-field');
    await owner.transfer({ assistantID: 'other', revision: 'r1' }); await flush();
    expect(owner.state()).toMatchObject({ status: 'connected', configured: true, hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner' });
    expect(owner.busy()).toBe(false);
    expect(await bindRequest(scope)('/fixture/assistants-settings/audit')).toMatchObject({ transfers: 1, channelWrites: 0, clearAttempts: 0 });
    expect({ clientID: owner.clientID(), ownerID: owner.ownerID(), secret: owner.secret() }).toEqual({ clientID: 'imported-client', ownerID: 'imported-owner', secret: '' });
    await owner.save(); await flush();
    expect(close).toHaveBeenCalledTimes(1);
    const send = bindRequest(scope);
    expect(await send('/fixture/assistants-settings/audit')).toMatchObject({ transfers: 1, channelWrites: 1, clearAttempts: 0 });
    const writes = h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0][1].body).toEqual({ clientID: 'imported-client', ownerID: 'imported-owner', language: 'en' });
  } finally { cleanups.reverse().forEach(work => work()); }
});
