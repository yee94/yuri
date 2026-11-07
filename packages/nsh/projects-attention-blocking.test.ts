import { describe, expect, it, vi } from 'vitest';
import { createProjectsBlocking, readProjectsBlocking, type ProjectsBlockingSnapshot } from './projects-attention-blocking';
import { createProjectsAttention, createProjectsAttentionSource } from './projects-attention';
import { resolveMobileSessionIndicator } from '../ui/src/mobile/projects/mobileSessionIndicator';
import type { RuntimeEvent } from './model';

const form = (id: string, sessionID = 'root', kind = 'question') => ({ id, sessionID, metadata: { kind }, title: 'Question', fields: [] });
const permission = (id: string, sessionID = 'root') => ({ id, sessionID, action: 'shell' });
const event = (type: string, body: Record<string, unknown>, directory = '/repo', created?: number): RuntimeEvent => ({ key: 'global', type, body, directory, created });
const route = (domain: 'form' | 'permission/request', directory = '/repo') => `/api/${domain}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let state: ProjectsBlockingSnapshot = {};
  const changed = vi.fn((next: ProjectsBlockingSnapshot) => { state = next; });
  const source = createProjectsBlocking(changed);
  return { source, changed, snapshot: () => state, read: (id = 'root', directory = '/repo') => readProjectsBlocking(state, directory, id) };
}

describe('Projects Location-level pending request authority', () => {
  it('reads loaded Locations once, aggregates both domains, and reuses exact Web priority without history', async () => {
    const f = fixture();
    expect(f.read()).toEqual({ hasPendingQuestion: false, hasPendingPermission: false, questionsKnown: false, permissionsKnown: false });
    const send = vi.fn(async (path: string): Promise<unknown> => path === '/api/debug/location' ? [{ directory: '/repo' }, { directory: '/other' }, { directory: '/repo/' }]
      : path === route('form') ? { data: [form('q'), form('generic', 'generic', 'input')] }
        : path === route('permission/request') ? { data: [permission('p')] } : { data: [] });
    await f.source.refresh(send, () => true);
    expect(send.mock.calls.map(([path]) => path)).toEqual(['/api/debug/location', route('form'), route('permission/request'), route('form', '/other'), route('permission/request', '/other')]);
    expect(f.read()).toEqual({ hasPendingQuestion: true, hasPendingPermission: true, questionsKnown: true, permissionsKnown: true });
    expect(f.read('generic').hasPendingQuestion).toBe(false);
    const indicator = () => resolveMobileSessionIndicator({ ...f.read(), running: true, unread: true });
    expect(indicator()).toBe('question');
    f.source.accept(event('form.replied', { sessionID: 'root', id: 'q' })); expect(indicator()).toBe('permission');
    f.source.accept(event('permission.replied', { sessionID: 'root', requestID: 'p' })); expect(indicator()).toBe('running');
  });
  it('matches request and session IDs, preserves blocks after viewed/terminal events, and does not resurrect resolved requests', () => {
    const attention = createProjectsAttention(); attention.activate('host-generation');
    const source = createProjectsAttentionSource({ attention, sessions: () => [{ id: 'root', title: 'Root', directory: '/repo', updated: 1 }] });
    source.accept('host-generation', event('form.created', form('q'), '/repo', 10));
    source.accept('host-generation', event('permission.asked', permission('p')));
    source.accept('host-generation', event('session.execution.succeeded', { sessionID: 'root' }));
    attention.setViewedSession('host-generation', 'root');
    const read = () => readProjectsBlocking(attention.snapshot('host-generation').blockingByDirectory, '/repo', 'root');
    expect(attention.snapshot('host-generation').unseenBySession).toEqual({});
    expect(read().hasPendingQuestion).toBe(true); expect(read().hasPendingPermission).toBe(true);
    source.accept('host-generation', event('form.replied', { sessionID: 'other', id: 'q' }));
    source.accept('host-generation', event('form.cancelled', { sessionID: 'root', id: 'different' }));
    source.accept('host-generation', event('form.replied', { sessionID: 'root' }));
    source.accept('host-generation', event('form.replied', { sessionID: 'root', id: 'q' }, '/wrong'));
    expect(read().hasPendingQuestion).toBe(true);
    source.accept('host-generation', event('form.replied', { sessionID: 'root', id: 'q' }, '/repo', 10));
    source.accept('host-generation', event('form.created', form('q'), '/repo', 9));
    source.accept('host-generation', event('form.created', form('q')));
    expect(read().hasPendingQuestion).toBe(false); expect(read().hasPendingPermission).toBe(true);
  });
  it('keeps prior authority on failures, isolates domains/directories, and distinguishes successful empty', async () => {
    const f = fixture();
    f.source.accept(event('form.created', form('q'))); f.source.accept(event('permission.asked', permission('p')));
    f.source.accept(event('permission.asked', permission('other', 'other'), '/other'));
    const send = async (path: string): Promise<unknown> => {
      if (path === '/api/debug/location') return [{ directory: '/repo' }, { directory: '/other' }];
      if (path === route('form')) throw new Error('unavailable');
      if (path === route('permission/request', '/other')) throw new Error('unavailable');
      return { data: [] };
    };
    await f.source.refresh(send, () => true);
    expect(f.read().hasPendingQuestion).toBe(true); expect(f.read().questionsKnown).toBe(false);
    expect(f.read().hasPendingPermission).toBe(false); expect(f.read().permissionsKnown).toBe(true);
    expect(f.read('other', '/other').hasPendingPermission).toBe(true);
    await f.source.refresh(async () => { throw new Error('inventory failure'); }, () => true);
    expect(f.read().hasPendingQuestion).toBe(true); expect(f.read('other', '/other').hasPendingPermission).toBe(true);
    expect(f.read().permissionsKnown).toBe(false);
    await f.source.refresh(async path => path === '/api/debug/location' ? [{ directory: '/repo' }] : { data: [] }, () => true);
    expect(f.read()).toEqual({ hasPendingQuestion: false, hasPendingPermission: false, questionsKnown: true, permissionsKnown: true });
    expect(f.snapshot()['/other']).toBeUndefined();
  });
  it('preserves only the failed session while complete sessions reconcile in the same aggregate', async () => {
    const f = fixture();
    for (const id of ['bad', 'gone', 'good']) f.source.accept(event('form.created', form(`q-${id}`, id)));
    await f.source.refresh(async path => path === '/api/debug/location' ? [{ directory: '/repo' }]
      : path === route('form') ? { data: [{ sessionID: 'bad' }, form('new', 'good')] } : [], () => true);
    expect(f.read('bad').hasPendingQuestion).toBe(true); expect(f.read('bad').questionsKnown).toBe(false);
    expect(f.read('gone').hasPendingQuestion).toBe(false); expect(f.read('good').questionsKnown).toBe(true);
    expect(f.snapshot()['/repo']!.questions.bySession.good).toEqual(['new']);
  });
  it('overlays only exact concurrent request IDs, including unseen resolutions, without losing another request in the same session', async () => {
    const f = fixture(), forms = deferred<unknown>();
    const promise = f.source.refresh(async path => path === '/api/debug/location' ? [{ directory: '/repo' }]
      : path === route('form') ? forms.promise : [], () => true);
    await vi.waitFor(() => expect(f.read().permissionsKnown).toBe(true));
    f.source.accept(event('form.replied', { sessionID: 'root', id: 'resolved-unseen' }));
    f.source.accept(event('form.created', form('live')));
    forms.resolve({ data: [form('resolved-unseen'), form('other-from-snapshot')] }); await promise;
    expect(f.snapshot()['/repo']!.questions.bySession.root).toEqual(['other-from-snapshot', 'live']);
  });
  it('fences moves, shutdown and stale old-directory snapshots even for an unknown catalog identity', async () => {
    const f = fixture(), forms = deferred<unknown>();
    f.source.accept(event('form.created', form('q')));
    const promise = f.source.refresh(async path => path === '/api/debug/location' ? [{ directory: '/repo' }]
      : path === route('form') ? forms.promise : [], () => true);
    await vi.waitFor(() => expect(f.read().permissionsKnown).toBe(true));
    f.source.accept(event('session.moved', { sessionID: 'root', location: { directory: '/new' } }, '/repo', 20));
    f.source.accept(event('session.moved', { sessionID: 'root', location: { directory: '/old' } }, '/repo', 10));
    f.source.accept(event('form.created', form('wrong-dir')));
    forms.resolve({ data: [form('q')] }); await promise;
    expect(f.read().hasPendingQuestion).toBe(false); expect(f.read('root', '/new').hasPendingQuestion).toBe(true);
    f.source.accept(event('location.shutdown', {}, '/new'));
    expect(f.read('root', '/new').hasPendingQuestion).toBe(false);
    const late = deferred<unknown>();
    const second = f.source.refresh(async path => path === '/api/debug/location' ? [{ directory: '/new' }]
      : path === route('form', '/new') ? late.promise : [], () => true);
    await vi.waitFor(() => expect(f.read('root', '/new').permissionsKnown).toBe(true));
    f.source.accept(event('location.shutdown', {}, '/new')); late.resolve([form('z')]); await second;
    expect(f.snapshot()['/new']).toBeUndefined();
  });
  it('coalesces reconnects, pauses hidden reads and rejects retired Host generations', async () => {
    const attention = createProjectsAttention(), delayed = deferred<unknown>(); attention.activate('A');
    const send = vi.fn(async (path: string): Promise<unknown> => path === '/api/debug/location' ? delayed.promise : []);
    const source = createProjectsAttentionSource({ attention, sessions: () => [], request: send });
    source.setActive('A', true);
    for (let i = 0; i < 50; i++) source.accept('A', event('reconnected', {}));
    expect(send).toHaveBeenCalledTimes(1);
    source.setActive('A', false); delayed.resolve([{ directory: '/repo' }]);
    await Promise.resolve(); await Promise.resolve(); expect(send).toHaveBeenCalledTimes(1);
    expect(attention.snapshot('A').blockingByDirectory).toEqual({});
    source.dispose(); attention.activate('B');
    source.setActive('B', true);
    await vi.waitFor(() => expect(readProjectsBlocking(attention.snapshot('B').blockingByDirectory, '/repo', 'root').questionsKnown).toBe(true));
    expect(attention.snapshot('A').blockingByDirectory).toEqual({});
    source.dispose(); attention.retire('B'); expect(attention.retainedScopeCount()).toBe(0);
  });
  it('recovers a move missed while hidden from later Location authority rather than freezing an earlier move fence', async () => {
    const f = fixture();
    f.source.accept(event('form.created', form('q')));
    f.source.accept(event('session.moved', { sessionID: 'root', location: { directory: '/intermediate' } }));
    await f.source.refresh(async path => path === '/api/debug/location' ? [{ directory: '/destination' }]
      : path === route('form', '/destination') ? [form('q')] : [], () => true);
    expect(f.read('root', '/intermediate').hasPendingQuestion).toBe(false);
    expect(f.read('root', '/destination').hasPendingQuestion).toBe(true);
    f.source.accept(event('form.replied', { sessionID: 'root', id: 'q' }, '/intermediate'));
    expect(f.read('root', '/destination').hasPendingQuestion).toBe(true);
    f.source.accept(event('form.replied', { sessionID: 'root', id: 'q' }, '/destination'));
    expect(f.read('root', '/destination').hasPendingQuestion).toBe(false);
  });
  it('rejects stale shutdown/creation frames at the directory lifetime boundary', () => {
    const f = fixture(); f.source.accept(event('form.created', form('new'), '/repo', 20));
    f.source.accept(event('location.shutdown', {}, '/repo', 10)); expect(f.read().hasPendingQuestion).toBe(true);
    f.source.accept(event('location.shutdown', {}, '/repo', 30)); expect(f.read().hasPendingQuestion).toBe(false);
    f.source.accept(event('form.created', form('late-old'), '/repo', 25)); expect(f.read().hasPendingQuestion).toBe(false);
    f.source.accept(event('form.created', form('fresh'), '/repo', 40)); expect(f.read().hasPendingQuestion).toBe(true);
  });
  it('never resurrects an explicitly resolved request from a later stale list or a replay after a move', async () => {
    const f = fixture();
    f.source.accept(event('form.replied', { sessionID: 'root', id: 'answered' }));
    await f.source.refresh(async path => path === '/api/debug/location' ? [{ directory: '/repo' }]
      : path === route('form') ? [form('answered'), form('valid')] : [], () => true);
    expect(f.snapshot()['/repo']!.questions.bySession.root).toEqual(['valid']);
    f.source.accept(event('session.moved', { sessionID: 'root', location: { directory: '/new' } }));
    f.source.accept(event('form.created', form('answered'), '/new'));
    expect(f.snapshot()['/new']!.questions.bySession.root).toEqual(['valid']);
  });
  it('keeps no-op references, does zero catalog work on token traffic, and bounds aggregate concurrency independently of row count', async () => {
    const f = fixture(); f.source.accept(event('form.created', form('q')));
    const prior = f.snapshot(); f.source.accept(event('form.created', form('q'))); expect(f.snapshot()).toBe(prior);
    const attention = createProjectsAttention(); attention.activate('A');
    let scans = 0;
    const source = createProjectsAttentionSource({ attention, sessions: () => { scans++; return Array.from({ length: 2000 }, (_, i) => ({ id: String(i), title: '', directory: '/repo', updated: 0 })); } });
    for (let i = 0; i < 1000; i++) source.accept('A', event('session.text.delta', { sessionID: '0', delta: 'x' }));
    expect(scans).toBe(0);
    let active = 0, maximum = 0;
    const send = vi.fn(async (path: string): Promise<unknown> => {
      if (path === '/api/debug/location') return Array.from({ length: 51 }, (_, i) => ({ directory: `/live/${i}` }));
      active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return [];
    });
    await f.source.refresh(send, () => true);
    expect(send).toHaveBeenCalledTimes(103); expect(maximum).toBeLessThanOrEqual(4);
    const snapshot = f.snapshot(); await f.source.refresh(send, () => true); expect(f.snapshot()).toBe(snapshot);
  });
});
