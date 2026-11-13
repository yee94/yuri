import { expect, test, vi } from 'vitest';
import type { AssistantContactSessionCardPart } from '@/queries/assistantDTO';
const f = vi.hoisted(() => ({ ensure: vi.fn(), summaries: vi.fn(), resolve: vi.fn(), open: vi.fn(), upsert: vi.fn() }));
vi.mock('@/queries/remoteProjectQueries', () => ({ ensureRemoteHostCatalog: f.ensure, ensureRemoteHostSummaries: f.summaries,
  getHostRuntimeRegistry: () => ({ resolve: f.resolve }) }));
vi.mock('@/router/openRemoteProjectSession', () => ({ openRemoteProjectSession: f.open }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ upsertRemoteProject: f.upsert }) } }));
import { assistantSessionReferenceKey, openAssistantRemoteSession } from './remoteSessionReference';
const card: AssistantContactSessionCardPart = { type: 'card', cardType: 'session', sessionID: 'same', directory: '/repo', title: 'Remote', status: 'complete', branch: null,
  target: { hubId: 'hub', hostId: 'a', instanceId: 'instance-a' } };

test('card keys isolate identical IDs and paths across authorities', () => {
  const local = { ...card, target: undefined };
  expect(new Set([local, card, { ...card, target: { ...card.target!, hostId: 'b' } }, { ...card, target: { ...card.target!, instanceId: 'replacement' } }].map(assistantSessionReferenceKey)).size).toBe(4);
});
test('remote navigation validates authority twice and uses the actual project route, never local lookup', async () => {
  const project = { id: 'p', hostId: 'a', path: '/repo', instanceId: 'instance-a' };
  f.ensure.mockResolvedValue({ supported: true, hubId: 'hub', projects: [project] });
  f.summaries.mockResolvedValue({});
  f.resolve.mockImplementation(() => ({ sdk: () => ({}) }));
  await openAssistantRemoteSession(card, true);
  expect(f.resolve).toHaveBeenCalledTimes(2);
  expect(f.resolve).toHaveBeenCalledWith({ ...card.target, directory: '/repo' });
  expect(f.open).toHaveBeenCalledWith(project, expect.any(Object), 'same', '/repo', true);
  f.open.mockClear();
  f.resolve.mockImplementation(() => { throw new Error('retargeted'); });
  await expect(openAssistantRemoteSession(card, false)).rejects.toThrow('retargeted');
  expect(f.open).not.toHaveBeenCalled();
});
