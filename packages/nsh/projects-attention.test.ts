import { describe, expect, it } from 'vitest';
import { createProjectsAttention, createProjectsAttentionSource, projectsInProgress } from './projects-attention';
import type { RuntimeEvent } from './model';

const event = (type: string, id?: string, sessionID = 'root'): RuntimeEvent => ({ key: 'global', type, body: { sessionID }, directory: '/repo', id });
describe('authoritative Projects attention', () => {
  it('keeps completed-unread in progress, clears only the opened session, and never guesses from history', () => {
    const source = createProjectsAttention();
    source.activate('host');
    const rows = [{ id: 'a', updated: 1, activity: 30 }, { id: 'b', updated: 100, activity: 20 }, { id: 'c', updated: 200, activity: 10 }];
    expect(projectsInProgress(rows, [], [], source.snapshot('host').unseenBySession)).toEqual([]);
    source.ingest('host', event('session.execution.succeeded', 'a-done', 'a'), rows[0]);
    source.ingest('host', event('session.execution.succeeded', 'b-done', 'b'), rows[1]);
    expect(projectsInProgress(rows, [], ['c'], source.snapshot('host').unseenBySession).map(row => row.id)).toEqual(['a', 'b', 'c']);
    source.markSessionViewed('host', 'a');
    expect(projectsInProgress(rows, [], [], source.snapshot('host').unseenBySession).map(row => row.id)).toEqual(['b']);
  });
  it('deduplicates succeeded plus idle, fences Host scopes and excludes child/unknown identities', () => {
    const source = createProjectsAttention(), root = { id: 'root' };
    source.activate('A');
    source.ingest('A', event('session.execution.succeeded', 'done'), root);
    source.ingest('A', event('session.execution.succeeded', 'done'), root);
    source.ingest('A', event('session.idle'), root);
    source.ingest('A', event('session.execution.failed'), { id: 'child', parentID: 'root' });
    source.ingest('A', event('session.execution.failed'), undefined);
    source.ingest('A', event('session.execution.failed', 'mismatch', 'different-session'), root);
    expect(source.snapshot('A').unseenBySession).toEqual({ root: 1 }); expect(source.snapshot('B').unseenBySession).toEqual({});
    source.ingest('A', event('session.execution.started'), root);
    source.ingest('A', event('session.execution.succeeded', 'second-done'), root);
    expect(source.snapshot('A').unseenBySession.root).toBe(2);
  });
  it('uses explicit foreground Chat authority and receives later unread after leaving', () => {
    const source = createProjectsAttention(), root = { id: 'root' };
    source.activate('A');
    source.setViewedSession('A', 'root');
    source.ingest('A', event('session.execution.succeeded'), root);
    expect(source.snapshot('A')).toEqual({ currentSessionID: 'root', unseenBySession: {}, blockingByDirectory: {} });
    source.setViewedSession('A', null);
    source.ingest('A', event('session.execution.started'), root);
    source.ingest('A', event('session.execution.failed'), root);
    expect(source.snapshot('A').unseenBySession).toEqual({ root: 1 });
    source.setViewedSession('A', 'root'); expect(source.snapshot('A').unseenBySession).toEqual({});
  });
  it('filters archived/child/pinned attention and orders by activity without ranking by identity', () => {
    const rows = [{ id: 'z', updated: 100, activity: 30 }, { id: 'a', updated: 300, activity: 10 }, { id: 'pin', updated: 100 }, { id: 'archived', updated: 400, archived: true }, { id: 'child', updated: 500, parentID: 'z' }];
    expect(projectsInProgress(rows, ['pin'], ['a', 'pin', 'archived', 'child'], { z: 1 }).map(row => row.id)).toEqual(['z', 'a']);
  });
  it('deduplicates failed/error/idle without event IDs within a run, including an already viewed terminal', () => {
    const source = createProjectsAttention(), root = { id: 'root' }; source.activate('A');
    source.ingest('A', event('session.execution.failed'), root);
    source.ingest('A', event('session.error'), root); source.ingest('A', event('session.execution.failed'), root); source.ingest('A', event('session.idle'), root);
    expect(source.snapshot('A').unseenBySession).toEqual({ root: 1 });
    source.setViewedSession('A', 'root'); source.ingest('A', event('session.execution.started'), root); source.ingest('A', event('session.execution.failed'), root);
    source.setViewedSession('A', null); source.ingest('A', event('session.error'), root);
    expect(source.snapshot('A').unseenBySession).toEqual({});
    source.ingest('A', { ...event('session.status'), body: { sessionID: 'root', status: { type: 'busy' } } }, root);
    source.ingest('A', event('session.execution.failed'), root); expect(source.snapshot('A').unseenBySession).toEqual({ root: 1 });
  });
  it('retires generations without LRU eviction and releases records only after their final listener detaches', () => {
    const source = createProjectsAttention(), root = { id: 'root' }; source.activate('A');
    const listener = () => {}, off = source.observe('A', listener), finalOff = source.observe('A', () => {});
    source.ingest('A', event('session.execution.succeeded'), root);
    for (let i = 0; i < 200; i++) expect(source.snapshot(`unknown-${i}`).unseenBySession).toEqual({});
    expect(source.retainedScopeCount()).toBe(1); expect(source.snapshot('A').unseenBySession).toEqual({ root: 1 });
    source.activate('B'); expect(source.retainedScopeCount()).toBe(2); expect(source.snapshot('A').unseenBySession).toEqual({});
    source.ingest('A', event('session.execution.failed'), root); source.setViewedSession('A', 'root');
    expect(source.snapshot('A').currentSessionID).toBeNull();
    off(); expect(source.retainedScopeCount()).toBe(2); finalOff(); expect(source.retainedScopeCount()).toBe(1);
    source.retire('B'); expect(source.retainedScopeCount()).toBe(0);
    source.ingest('B', event('session.execution.failed'), root); source.markSessionViewed('B', 'root');
    expect(source.retainedScopeCount()).toBe(0);
    for (let i = 0; i < 200; i++) { const key = `generation-${i}`; source.activate(key); const stop = source.observe(key, listener); source.retire(key); stop(); }
    expect(source.retainedScopeCount()).toBe(0);
  });
  it('allows subscribers before activation without accepting events and removes abandoned pending subscribers', () => {
    const source = createProjectsAttention(), root = { id: 'root' };
    const off = source.observe('pending', () => {});
    source.ingest('pending', event('session.execution.failed'), root); expect(source.snapshot('pending').unseenBySession).toEqual({});
    source.activate('pending'); source.ingest('pending', event('session.execution.failed'), root); off();
    expect(source.retainedScopeCount()).toBe(1); expect(source.snapshot('pending').unseenBySession).toEqual({ root: 1 });
    source.retire('pending'); expect(source.retainedScopeCount()).toBe(0);
    const abandoned = source.observe('never-active', () => {}); abandoned(); expect(source.retainedScopeCount()).toBe(0);
  });
  it('the root source ignores chat/token events before reading the catalog and invalidates its identity map by array and scope', () => {
    const attention = createProjectsAttention(); attention.activate('A');
    let reads = 0, iterations = 0;
    let rows = new Proxy([{ id: 'root', title: 'Root', directory: '/repo', updated: 1 }], { get(target, key, receiver) { if (key === Symbol.iterator) iterations++; return Reflect.get(target, key, receiver); } });
    const source = createProjectsAttentionSource({ attention, sessions: () => { reads++; return rows; } });
    for (let i = 0; i < 50; i++) source.accept('A', event('session.text.delta'));
    source.accept('A', { ...event('session.execution.failed'), key: 'chat' }); expect(reads).toBe(0);
    source.accept('A', event('session.execution.failed')); expect(reads).toBe(1); expect(iterations).toBe(1);
    source.accept('A', event('session.execution.started')); source.accept('A', event('session.error')); expect(iterations).toBe(1);
    rows = [{ id: 'other', title: 'Other', directory: '/repo', updated: 2 }]; source.accept('A', event('session.execution.failed')); expect(attention.snapshot('A').unseenBySession.root).toBe(2);
    attention.activate('B'); source.accept('B', event('session.execution.failed')); expect(attention.snapshot('B').unseenBySession).toEqual({});
    source.dispose();
  });
});
