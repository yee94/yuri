import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { HostRuntimeContext } from '@/contexts/hostRuntimeContext';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { HostContentDemand } from '@/lib/remote-projects/content-demand';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectRuntimeAPIs } from './useProjectRuntimeAPIs';

const state = vi.hoisted(() => ({
  local: { files: {}, git: {}, terminal: {}, github: {}, editor: {}, runtime: { isDesktop: true } },
  owners: [] as Array<{ dispose: ReturnType<typeof vi.fn>; createTerminalSession: ReturnType<typeof vi.fn>; connectTerminalStream: ReturnType<typeof vi.fn>; sendTerminalInput: ReturnType<typeof vi.fn>; resizeTerminal: ReturnType<typeof vi.fn>; closeTerminal: ReturnType<typeof vi.fn>; restartTerminalSession: ReturnType<typeof vi.fn> }>,
  create: vi.fn(),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => state.local }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/local' }));
vi.mock('@/lib/terminalApi', () => ({ createProjectTerminalAPI: (...args: unknown[]) => state.create(...args) }));

let root: Root;
let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.clearAllMocks(); state.owners.length = 0; });

test('the production project capability boundary is lazy and owns terminal create/connect/input/resize/close/cleanup per Host', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.create.mockImplementation(() => {
    const owner = { dispose: vi.fn(), createTerminalSession: vi.fn(async () => ({ sessionId: 'pty' })),
      connectTerminalStream: vi.fn(() => vi.fn()), sendTerminalInput: vi.fn(async () => {}),
      resizeTerminal: vi.fn(async () => {}), closeTerminal: vi.fn(async () => {}), restartTerminalSession: vi.fn() };
    state.owners.push(owner); return owner;
  });
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: vi.fn(), sdk: () => opencodeClient.getSdkClient(), service: () => { throw new Error('Unexpected service'); } });
  let current!: ReturnType<typeof useProjectRuntimeAPIs>;
  function Consumer() { current = useProjectRuntimeAPIs(); return null; }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const render = async (hostId: string) => {
    const entry = registry.resolve({ hubId: 'hub', hostId, directory: '/raw' });
    await act(async () => root.render(<HostRuntimeContext.Provider value={{ registry, entry, demand: new HostContentDemand(registry) }}><Consumer /></HostRuntimeContext.Provider>));
  };
  await render('a');
  const entryA = current.projectScope;
  for (let i = 0; i < 50; i++) await act(async () => root.render(<HostRuntimeContext.Provider value={{ registry, entry: entryA!, demand: new HostContentDemand(registry) }}><Consumer /></HostRuntimeContext.Provider>));
  expect(state.create).not.toHaveBeenCalled();
  expect(current.files.revealPath).toBeUndefined();
  expect(current.editor).toBeUndefined();
  expect(current.github).toBeUndefined();
  await current.terminal.createSession({ cwd: '/raw', cols: 100, rows: 30 });
  const subscription = current.terminal.connect('pty', { onEvent: vi.fn() }, { retry: { maxRetries: 2 }, connectionTimeoutMs: 42 });
  await current.terminal.sendInput('pty', 'hello');
  await current.terminal.resize({ sessionId: 'pty', cols: 120, rows: 40 });
  await current.terminal.close('pty');
  subscription.close();
  expect(state.create).toHaveBeenCalledOnce();
  const ownerA = state.owners[0];
  expect(ownerA.connectTerminalStream).toHaveBeenCalledWith('pty', expect.any(Function), undefined, expect.objectContaining({ maxRetries: 2, connectionTimeout: 42 }));
  expect(ownerA.sendTerminalInput).toHaveBeenCalledWith('pty', 'hello');
  expect(ownerA.resizeTerminal).toHaveBeenCalledWith('pty', 120, 40);
  expect(ownerA.closeTerminal).toHaveBeenCalledWith('pty');
  await render('b');
  expect(ownerA.dispose).toHaveBeenCalledOnce();
  await current.terminal.createSession({ cwd: '/raw' });
  expect(state.create).toHaveBeenLastCalledWith(current.projectScope);
  expect(state.owners).toHaveLength(2);
});
