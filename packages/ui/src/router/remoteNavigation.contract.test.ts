import { expect, test } from 'vitest';
import { buildNewSessionPath, buildSessionPath, parseAppPath } from './pathContract';
import { createAppRouter } from './createAppRouter';
import { createAppNavigation } from './navigation';

const location = { hubId: 'hub-甲', hostId: 'host/a', directory: 'C:\\Raw Path\\' };

test('remote session and draft paths preserve raw filesystem location and independent Hub reference identity', () => {
  const path = buildSessionPath({ sessionId: 'same-id', location, projectId: 'hub-reference', tab: 'files', file: 'a/b.ts' });
  expect(parseAppPath(path)).toEqual({ kind: 'session', sessionId: 'same-id', location, projectId: 'hub-reference', tab: 'files', file: 'a/b.ts', scope: null });
  expect(parseAppPath(buildNewSessionPath({ location, projectId: 'hub-reference' }))).toEqual({ kind: 'new', location, projectId: 'hub-reference' });
  expect(buildSessionPath({ sessionId: 'same-id' })).toBe('/session/same-id');
});

test('partial remote location is rejected rather than interpreted as a local session route', () => {
  expect(parseAppPath('/session/same-id?hostId=a')).toEqual({ kind: 'unknown' });
  expect(parseAppPath('/session/new?hostId=a')).toEqual({ kind: 'unknown' });
  expect(parseAppPath('/session/same-id?instanceId=remote')).toEqual({ kind: 'unknown' });
  expect(() => buildSessionPath({ sessionId: 'same-id', location: { hubId: '', hostId: 'a', directory: '/raw' } })).toThrow();
});

test('target instance identity survives route serialization', () => {
  const target = { ...location, instanceId: 'instance-a' };
  expect(parseAppPath(buildSessionPath({ sessionId: 'same-id', location: target }))).toMatchObject({ location: target });
});

test('production navigation intents carry Host identity across session tools and new drafts', async () => {
  const router = createAppRouter({ runtime: 'electron' });
  const navigation = createAppNavigation(router);
  await navigation.applyIntent({ type: 'session', sessionId: 'same-id', location, projectId: 'hub-reference', tab: 'git' });
  expect(parseAppPath(`${router.state.location.pathname}${router.state.location.searchStr}`)).toMatchObject({ kind: 'session', sessionId: 'same-id', tab: 'git', location, projectId: 'hub-reference' });
  await navigation.applyIntent({ type: 'new-session', location, projectId: 'hub-reference' });
  expect(parseAppPath(`${router.state.location.pathname}${router.state.location.searchStr}`)).toEqual({ kind: 'new', location, projectId: 'hub-reference' });
});
