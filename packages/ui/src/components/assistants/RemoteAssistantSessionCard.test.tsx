import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import type { AssistantContactSessionCardPart } from '@/queries/assistantDTO';

const f = vi.hoisted(() => ({ local: vi.fn(), branches: vi.fn(), resolve: vi.fn(), stale: false }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  useRemoteProjectRuntime: () => ({ catalog: { hubId: 'hub' }, registry: { resolve: f.resolve } }),
  useRemoteHostSummaries: (_registry: unknown, hostId: string) => ({ data: { stale: f.stale, directories: [{ directory: '/repo', sessions: [
    { id: 'same', directory: '/repo', title: `Remote ${hostId}`, time: { created: 1, updated: 1 }, metadata: { yuri: { sessionStatus: { type: 'busy' } } } },
  ] }] } }),
}));
vi.mock('@/queries/gitBranchQueries', () => ({ gitBranchesQueryOptions: (_directory: string, _git: unknown, _transport: unknown, _storage: unknown, entry: { location: { hostId: string } }) => ({
  queryKey: ['branches', entry.location.hostId], queryFn: () => { f.branches(entry.location.hostId); return { current: `branch-${entry.location.hostId}` }; },
}) }));
vi.mock('./AssistantSessionCard', () => ({ SessionCardView: ({ card, liveSession, liveType, branch }: { card: AssistantContactSessionCardPart; liveSession?: { title: string }; liveType?: string; branch: string | null }) =>
  <div data-host={card.target?.hostId}>{liveSession?.title ?? card.title}|{liveType ?? 'unknown'}|{branch}</div> }));

import RemoteAssistantSessionCard from './RemoteAssistantSessionCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); client.clear(); f.branches.mockClear(); f.resolve.mockReset(); });

test('same-ID remote receipts read only their own scoped branches and status, and retarget failure keeps the receipt', async () => {
  f.resolve.mockImplementation((location) => {
    if (location.instanceId !== `instance-${location.hostId}`) throw new Error('retargeted');
    return { location, queryScope: [location.hostId, location.instanceId] };
  });
  const card = (hostId: string): AssistantContactSessionCardPart => ({ type: 'card', cardType: 'session', sessionID: 'same', directory: '/repo', title: 'Receipt', status: 'complete', branch: 'saved',
    target: { hubId: 'hub', hostId, instanceId: `instance-${hostId}` } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = (cards: AssistantContactSessionCardPart[]) => root!.render(<QueryClientProvider client={client}>{cards.map((card) => <RemoteAssistantSessionCard key={card.target!.hostId} card={card} />)}</QueryClientProvider>);
  await act(async () => { render([card('a'), card('b')]); await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.textContent).toContain('Remote a|busy|branch-a');
  expect(host.textContent).toContain('Remote b|busy|branch-b');
  expect(f.branches.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b']);
  await act(async () => render([{ ...card('a'), target: { ...card('a').target!, instanceId: 'replacement' } }]));
  expect(host.textContent).toBe('Receipt|unknown|');
  expect(f.branches).toHaveBeenCalledTimes(2);
});
