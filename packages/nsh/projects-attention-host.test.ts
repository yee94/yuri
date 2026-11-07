import { expect, it, vi } from 'vitest';
import { createHost } from './projects-attention-host.js';
import { createProjectsAttention, createProjectsAttentionSource } from './projects-attention';
import { readProjectsBlocking } from './projects-attention-blocking';
import { runtimeEventFrom } from './model';

it('the isolated focused fixture exercises the real source, failure/prior recovery and exact native wire without an engine', async () => {
  const attention = createProjectsAttention(); attention.activate('fixture');
  let source: ReturnType<typeof createProjectsAttentionSource>;
  const fixture = createHost({ hostEvent: (_name: string, payload: unknown) => { const event = runtimeEventFrom(payload); if (event) source.accept('fixture', event); } });
  source = createProjectsAttentionSource({ attention, sessions: () => [], request: async path => {
    const result = fixture.call('runtime.request', { path, method: 'GET' });
    if (!result || result.status !== 200) throw new Error('Fixture failure'); return result.body;
  } });
  const read = () => readProjectsBlocking(attention.snapshot('fixture').blockingByDirectory, '/fixture/repo', 'root');
  source.setActive('fixture', true); await vi.waitFor(() => expect(read().questionsKnown).toBe(true));
  expect(read().hasPendingQuestion).toBe(true); expect(read().hasPendingPermission).toBe(true);
  attention.setViewedSession('fixture', 'root'); expect(read().hasPendingQuestion).toBe(true);
  fixture.call('projects.attention.fixture', { action: 'question' }); expect(read().hasPendingQuestion).toBe(false); expect(read().hasPendingPermission).toBe(true);
  fixture.call('projects.attention.fixture', { action: 'permission' }); expect(read().hasPendingPermission).toBe(false);
  fixture.call('projects.attention.fixture', { action: 'fail' }); await vi.waitFor(() => expect(read().questionsKnown).toBe(false)); expect(read().hasPendingQuestion).toBe(true);
  fixture.call('projects.attention.fixture', { action: 'recover' }); await vi.waitFor(() => expect(read().questionsKnown).toBe(true)); expect(read().hasPendingQuestion).toBe(false);
  expect(fixture.call('projects.attention.fixture', { action: 'audit' })).toMatchObject({ rejectedRequests: 0 });
  source.dispose(); attention.retire('fixture');
});
it('the focused Host rejects default-Location, per-row, mutation and malformed request guesses', () => {
  const fixture = createHost({ hostEvent: () => {} });
  for (const input of [
    { path: '/api/form?directory=%2Ffixture%2Frepo', method: 'GET' },
    { path: '/api/form?location%5Bdirectory%5D=%2Fother', method: 'GET' },
    { path: '/api/form', method: 'GET' },
    { path: '/api/session/root/form', method: 'GET' },
    { path: '/api/form?location%5Bdirectory%5D=%2Ffixture%2Frepo', method: 'POST', body: {} },
  ]) expect(() => fixture.call('runtime.request', input)).toThrow();
});
