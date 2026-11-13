import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';

// Execute the production JSX boundary while replacing only the large composer body.
test('remote composer blocks offline and unsupported sends without unmounting its draft; typing does no host reads', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
  const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'RemoteChatInput') declaration = `const ${node.getText(ast)};`;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const compiled = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  let supported = true;
  const send = vi.fn();
  const Runtime = ({ submissionBlocked }: { submissionBlocked: boolean }) => {
    const [draft, setDraft] = React.useState('retained draft');
    return <><input value={draft} onChange={(event) => setDraft(event.target.value)} /><button disabled={submissionBlocked} onClick={() => send(draft)}>Send</button></>;
  };
  const RemoteInput = new Function('React', 'useRemoteHost', 'supportsRemoteProjects', 'RemoteHostIndicator', 'ChatInputRuntime', `${compiled}; return RemoteChatInput;`)(React, useRemoteHost, () => supported, () => null, Runtime) as React.ComponentType<{ registry: HostRuntimeRegistry; hostId: string }>;
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch: vi.fn(), sdk: () => { throw new Error('Unused'); }, service: () => { throw new Error('Unused'); } });
  const host = { id: 'remote', name: 'Remote', source: 'direct' as const, state: 'connected' as const };
  registry.applyCatalog({ hubId: 'hub', supported: true, hosts: [host], projects: [] });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<RemoteInput registry={registry} hostId="remote" />));
    const input = container.querySelector('input')!;
    const reads = vi.spyOn(registry, 'getHost');
    for (let index = 0; index < 50; index++) await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, `draft ${index}`);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(reads).not.toHaveBeenCalled();
    await act(async () => registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'remote', host: { ...host, state: 'offline' } } }));
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('draft 49');
    expect(container.querySelector('button')!.disabled).toBe(true);
    await act(async () => container.querySelector('button')!.click()); expect(send).not.toHaveBeenCalled();
    await act(async () => registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'remote', host } }));
    expect(container.querySelector('button')!.disabled).toBe(false);
    supported = false;
    await act(async () => root.render(<RemoteInput registry={registry} hostId="remote" />));
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(input.value).toBe('draft 49');
  } finally { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});
