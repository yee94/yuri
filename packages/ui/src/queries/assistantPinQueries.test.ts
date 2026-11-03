import { afterEach, beforeEach, expect, test, vi } from 'vitest';
// @ts-expect-error Shared server contract fixture is JavaScript.
import { assistantContractFixtures } from '../../../web/server/lib/assistants/contracts.js';
import { assistantSnapshotQueryOptions, updateAssistant, type AssistantDTO, type AssistantSnapshot } from './assistantQueries';
import { queryClient } from '@/lib/queryRuntime';

const io = vi.hoisted(() => ({ fetch: vi.fn(), transport: 'a', generation: 1 }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: io.fetch }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => io.transport,
  getRuntimeGeneration: () => io.generation,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: () => () => {} }));
const assistant: AssistantDTO = { ...assistantContractFixtures.assistant, avatarSeed: 'saved-avatar', pinnedAt: null };
const snapshot: AssistantSnapshot = { enabled: true, revision: 4, assistants: [assistant] };
beforeEach(() => {
  io.transport = 'a'; io.generation = 1; io.fetch.mockReset();
  queryClient.setQueryData(assistantSnapshotQueryOptions('a').queryKey, snapshot);
});
afterEach(() => queryClient.clear());

test('pin PATCH carries only intent and revision, then reconciles both owners in its runtime snapshot', async () => {
  const next = { ...assistant, pinnedAt: 123, revision: 5 };
  const previous = { ...assistant, id: 'previous', pinnedAt: 100 };
  queryClient.setQueryData(assistantSnapshotQueryOptions('a').queryKey, { ...snapshot, assistants: [assistant, previous] });
  const confirmed = { ...snapshot, revision: 5, assistants: [next, { ...previous, pinnedAt: null, revision: previous.revision + 1 }] };
  io.fetch.mockResolvedValueOnce(new Response(JSON.stringify(next)))
    .mockResolvedValueOnce(new Response(JSON.stringify(confirmed)));
  queryClient.setQueryData(assistantSnapshotQueryOptions('b').queryKey, snapshot);
  expect(await updateAssistant(assistant, { pinned: true })).toMatchObject({ pinnedAt: 123, revision: 5 });
  const [path, init] = io.fetch.mock.calls[0] as [string, RequestInit];
  expect(path).toBe(`/api/yuri/assistants/${assistant.id}`);
  expect(init.method).toBe('PATCH');
  expect(JSON.parse(String(init.body))).toEqual({ pinned: true, expectedRevision: assistant.revision });
  expect(io.fetch.mock.calls[1][0]).toBe('/api/yuri/assistants/snapshot');
  expect(queryClient.getQueryData(assistantSnapshotQueryOptions('a').queryKey)).toEqual(confirmed);
  expect(queryClient.getQueryData(assistantSnapshotQueryOptions('b').queryKey)).toBe(snapshot);
});

test('failed writes keep the authoritative snapshot untouched', async () => {
  io.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'revision_conflict' }), { status: 409 }));
  await expect(updateAssistant(assistant, { pinned: true })).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(queryClient.getQueryData(assistantSnapshotQueryOptions('a').queryKey)).toBe(snapshot);
});

test('a failed post-write refresh preserves the previous complete catalog until reconciliation recovers', async () => {
  io.fetch.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === 'PATCH'
    ? new Response(JSON.stringify({ ...assistant, pinnedAt: 123, revision: 5 }))
    : new Response(JSON.stringify({ error: 'offline' }), { status: 503 }));
  await expect(updateAssistant(assistant, { pinned: true })).rejects.toMatchObject({ code: 'offline' });
  expect(queryClient.getQueryData(assistantSnapshotQueryOptions('a').queryKey)).toBe(snapshot);
});

test('pin reconciliation cancels a pre-write snapshot instead of joining its stale result', async () => {
  const next = { ...assistant, pinnedAt: 123, revision: 5 };
  const confirmed = { ...snapshot, revision: 5, assistants: [next] };
  let staleSignal!: AbortSignal;
  io.fetch.mockImplementationOnce((_path: string, init: RequestInit) => {
    staleSignal = init.signal as AbortSignal;
    return new Promise(() => {});
  }).mockResolvedValueOnce(new Response(JSON.stringify(next)))
    .mockResolvedValueOnce(new Response(JSON.stringify(confirmed)));
  const oldRead = queryClient.fetchQuery(assistantSnapshotQueryOptions('a')).catch(() => undefined);
  await updateAssistant(assistant, { pinned: true });
  await oldRead;
  expect(staleSignal.aborted).toBe(true);
  expect(io.fetch).toHaveBeenCalledTimes(3);
  expect(queryClient.getQueryData(assistantSnapshotQueryOptions('a').queryKey)).toEqual(confirmed);
});

test('late mutation results cannot move contacts after switching runtimes', async () => {
  let finish!: (response: Response) => void;
  io.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = updateAssistant(assistant, { pinned: true });
  io.transport = 'b'; io.generation = 2;
  queryClient.setQueryData(assistantSnapshotQueryOptions('b').queryKey, snapshot);
  finish(new Response(JSON.stringify({ ...assistant, pinnedAt: 123, revision: 5 })));
  await expect(pending).rejects.toMatchObject({ code: 'runtime_stale' });
  expect(queryClient.getQueryData(assistantSnapshotQueryOptions('a').queryKey)).toBe(snapshot);
  expect(queryClient.getQueryData(assistantSnapshotQueryOptions('b').queryKey)).toBe(snapshot);
});
