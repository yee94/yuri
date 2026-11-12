import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { RemoteHost } from '@/lib/remote-projects/types';
import type { HostRuntimeContextValue } from '@/contexts/hostRuntimeContext';

const state = vi.hoisted(() => ({
  host: { id: 'a', name: 'A', source: 'ssh', state: 'connecting' } as RemoteHost,
  listeners: new Set<() => void>(), reads: 0, renderable: false,
}));
vi.mock('@/contexts/HostRuntimeProvider', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); };
  return { useRemoteHost: () => { state.reads++; return useSyncExternalStore(subscribe, () => state.host); } };
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/sync/sync-context', () => ({}));
vi.mock('@/stores/useConfigStore', () => ({}));
vi.mock('@/sync/transcript-repository-runtime', () => ({
  subscribeTranscriptRepositoryBinding: () => () => {}, getTranscriptRepositoryBindingRevision: () => 0,
  transcriptScope: () => ({}), getTranscriptRepository: () => repository,
}));
vi.mock('@/sync/transcript-authority-refresh-flight', () => ({ subscribeTranscriptAuthorityRefresh: () => () => {}, isTranscriptAuthorityRefreshInFlight: () => false }));
vi.mock('@/sync/transcript-resync-flight', () => ({ subscribeTranscriptResync: () => () => {}, isTranscriptResyncInFlight: () => false }));
const repository = { subscribe: () => () => {}, getHydrationState: () => ({ p0Satisfied: state.renderable }), getRequestState: () => ({ status: 'loading' }) };

import { RemoteComposerConnectionStatus } from './RemoteComposerConnectionStatus';
import { useRemoteMobileTranscriptSyncHint } from '@/mobile/chat/useMobileTranscriptSyncHint';

const context = { registry: {}, entry: { location: { hubId: 'hub', hostId: 'a', directory: '/' } } } as unknown as HostRuntimeContextValue;
function MobileHint({ session = 'session' }: { session?: string }) {
  return <span>{useRemoteMobileTranscriptSyncHint(context, session)}</span>;
}
const container = document.createElement('div');
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  state.host = { id: 'a', name: 'A', source: 'ssh', state: 'connecting' };
  state.renderable = false;
  vi.useRealTimers();
});
const update = async (patch: Partial<RemoteHost>) => act(async () => {
  state.host = { ...state.host, ...patch };
  for (const notify of state.listeners) notify();
});

it('shows live preparation at the composer without layout space or typing-driven subscriptions', async () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
  const jsx = source.match(/<RemoteComposerConnectionStatus\s[^>]+\/>/)?.[0];
  expect(jsx).toBeTruthy();
  const expression = ts.transpileModule(`const slot = ${jsx};`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext } }).outputText;
  const slot = new Function('React', 'RemoteComposerConnectionStatus', 'hostRuntime', `${expression}; return slot;`);
  const render = (edit: number) => <section data-edit={edit}>{slot(React, RemoteComposerConnectionStatus, context)}</section>;
  await act(async () => root.render(render(0)));
  const reads = state.reads; const subscriptions = state.listeners.size;
  for (let edit = 1; edit <= 50; edit++) await act(async () => root.render(render(edit)));
  expect(state.reads).toBe(reads); expect(state.listeners.size).toBe(subscriptions);
  expect(container.querySelector('[role="status"]')?.className).toContain('absolute');
  await update({ preparationPhase: 'updating' });
  expect(container.textContent).toBe('remoteProjects.preparation.updating');
  expect(container.querySelector('.animate-spin')).not.toBeNull();
  await update({ state: 'offline' });
  expect(container.textContent).toBe('remoteProjects.state.offline');
  expect(container.querySelector('.animate-spin')).toBeNull();
  await update({ state: 'connected', preparationPhase: undefined });
  expect(container.textContent).toBe('');
});

it('gives preparation priority on mobile even for warm transcripts and new drafts, then hands off to message sync', async () => {
  vi.useFakeTimers(); state.renderable = true;
  await act(async () => root.render(<MobileHint session="" />));
  await update({ preparationPhase: 'installing' });
  expect(container.textContent).toBe('remoteProjects.preparation.installing');
  await act(async () => root.render(<MobileHint />));
  await update({ preparationPhase: 'updating' });
  expect(container.textContent).toBe('remoteProjects.preparation.updating');
  await update({ state: 'offline' });
  expect(container.textContent).toBe('remoteProjects.state.offline');
  state.renderable = false;
  await update({ state: 'connected', preparationPhase: undefined });
  await act(async () => vi.advanceTimersByTime(250));
  expect(container.textContent).toBe('mobile.chat.syncingMessages');
  state.renderable = true;
  await act(async () => root.render(<MobileHint />));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).toBe('');
});
