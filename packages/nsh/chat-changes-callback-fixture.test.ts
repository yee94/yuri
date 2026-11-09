import { expect, test } from 'vitest';
import { createHost } from './chat-changes-callback-fixture-host.js';
import { createChangesReader } from './chat-changes-model';
import { createChangesActions } from './chat-changes-actions';

test('callback fixture serves successful GET after unknown commit without changing the write outcome or replaying a POST', async () => {
  const mock = createHost();
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const result = mock.call('runtime.request', { path, method, body, expectedHost: { hostID: 'changes-callback-fixture', lease: 'fixture-only' } });
    if (result.status >= 400) throw Object.assign(new Error('Mock response lost'), { status: result.status });
    return result.body;
  };
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, request);
  await reader.refresh();
  const actions = createChangesActions(reader, request);
  expect(await actions.commit('fixture subject')).toBe(false);
  expect(actions.state().unknown).toBe(true);
  const before = mock.audit().statusReads;
  await reader.refresh();
  expect(mock.audit().statusReads).toBe(before + 1);
  expect(reader.state().error).toBe('');
  expect(actions.state()).toMatchObject({ pending: false, needsRefresh: false, unknown: true });
  expect(await actions.commit('nonempty draft after GET')).toBe(false);
  expect(await actions.move(['src/deep/b.ts'], false)).toBe(false);
  expect(mock.audit()).toMatchObject({ commits: 1, generates: 0, posts: ['/api/git/commit'] });
});
