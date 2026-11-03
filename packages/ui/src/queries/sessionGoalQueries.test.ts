import { afterEach, expect, test, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: {
  getScopedSdkClient: () => ({ rpc: () => ({ get }) }), getSdkClient: () => ({ rpc: () => ({ get }) }),
} }));
import { sessionGoalQueryOptions, handleSessionGoalEvent } from './sessionGoalQueries';
const goal = { id: 'g1', objective: 'Ship', status: 'active', rounds: 0, maxRounds: 50, boot: 'boot', updatedAt: 1 };
afterEach(() => { queryClient.clear(); get.mockReset(); });

test('reads native RPC with directory and cancellation, scoped to runtime and session', async () => {
  get.mockResolvedValue(goal);
  const options = sessionGoalQueryOptions('ses_a', '/repo');
  expect(await queryClient.fetchQuery(options)).toEqual(goal);
  expect(get).toHaveBeenCalledWith({ sessionID: 'ses_a' }, { location: { directory: '/repo' }, signal: expect.any(AbortSignal) });
  expect(options.queryKey).not.toEqual(sessionGoalQueryOptions('ses_a', '/other').queryKey);
  expect(options.queryKey).not.toEqual(sessionGoalQueryOptions('ses_a', '/repo', 'other-host').queryKey);
});

test('changed snapshot wins over an older in-flight GET and clear is authoritative', async () => {
  let finish!: (value: unknown) => void;
  get.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const options = sessionGoalQueryOptions('ses_a', '/repo');
  const pending = queryClient.fetchQuery(options).catch(() => undefined);
  handleSessionGoalEvent('/repo', { type: 'rpc.opencode.goal.changed', properties: { sessionID: 'ses_a', goal: { ...goal, status: 'paused', updatedAt: 2 } } });
  finish(goal);
  await pending;
  expect(queryClient.getQueryData(options.queryKey)).toMatchObject({ status: 'paused' });
  handleSessionGoalEvent('/repo', { type: 'rpc.opencode.goal.changed', properties: { sessionID: 'ses_a', goal: null } });
  expect(queryClient.getQueryData(options.queryKey)).toBeNull();
});

test('failed refresh and malformed events preserve prior native state; reconnect invalidates only current runtime', async () => {
  const options = sessionGoalQueryOptions('ses_a', '/repo');
  queryClient.setQueryData(options.queryKey, goal);
  queryClient.setQueryData(['other-host', 'session-goal', '/repo', 'ses_a'], goal);
  get.mockRejectedValue(new Error('offline'));
  await expect(queryClient.fetchQuery({ ...options, staleTime: 0, retry: false })).rejects.toThrow('offline');
  handleSessionGoalEvent('/repo', { type: 'rpc.opencode.goal.changed', properties: { sessionID: 'ses_a', goal: {} } });
  expect(queryClient.getQueryData(options.queryKey)).toEqual(goal);
  handleSessionGoalEvent('', { type: 'server.connected' });
  expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(['other-host', 'session-goal', '/repo', 'ses_a'])?.isInvalidated).toBe(false);
  expect(options.queryKey[0]).toBe(getRuntimeTransportIdentity());
});
