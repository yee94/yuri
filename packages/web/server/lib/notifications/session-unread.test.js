import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { createSessionUnreadStore } from './session-unread-store.js';
import { createSessionUnreadRuntime } from './session-unread-runtime.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixture = (options = {}) => {
  const { seed, ...runtimeOptions } = options;
  const changed = vi.fn();
  const store = createSessionUnreadStore({ dbPath: ':memory:', onChanged: changed });
  seed?.(store);
  const loadSession = vi.fn(async id => ({ id, title: 'Conversation', location: { directory: '/project' } }));
  const runtime = createSessionUnreadRuntime({ store, loadSession, ...runtimeOptions });
  cleanup.push(() => runtime.close());
  const event = (type, sessionID = 'one', created = undefined, seq = undefined) => runtime.processEvent({
    payload: { type, data: { sessionID }, created, ...(seq ? { durable: { seq } } : {}) },
  });
  const app = express();
  runtime.registerRoutes(app);
  return { store, runtime, event, app, loadSession, changed };
};

describe('shared session unread', () => {
  it('excludes explicitly linked CLI workers without guessing from titles or agent names', async () => {
    const { store, event, loadSession, app } = fixture();
    loadSession.mockImplementation(async id => ({ id, title: 'Worker', agent: 'general', directory: '/project',
      metadata: { yuri: { worker: { parentSessionID: id === 'worker' ? 'root' : '' } } },
    }));
    await event('session.execution.succeeded', 'worker');
    await event('session.execution.failed', 'worker');
    expect((await request(app).put('/api/yuri/session-unread/worker').send({ unread: true })).status).toBe(400);
    await event('session.execution.succeeded', 'ordinary');
    expect(Object.keys(store.snapshot().sessions)).toEqual(['ordinary']);
  });

  it('reconciles persisted child/worker attention once and retains unread state for ordinary roots', async () => {
    const { app, store, loadSession } = fixture({ seed: store => {
      for (const id of ['child', 'worker', 'missing', 'root']) store.mark({ id, directory: '/project', unread: true });
    } });
    loadSession.mockImplementation(async id => id === 'missing' ? null : ({ id, directory: '/project',
      ...(id === 'child' ? { parentID: 'root' } : {}),
      ...(id === 'worker' ? { metadata: { yuri: { worker: { parentSessionID: 'root' } } } } : {}),
    }));
    const first = await request(app).get('/api/yuri/session-unread');
    expect(first.status).toBe(200);
    expect(Object.keys(first.body.sessions)).toEqual(['root']);
    expect(first.body.sessions.root).toMatchObject({ unreadCount: 1, manual: true });
    expect(store.snapshot()).toEqual(first.body);
    expect((await request(app).get('/api/yuri/session-unread')).body).toEqual(first.body);
    expect(loadSession).toHaveBeenCalledTimes(4);
  });

  it('preserves failed startup identities, repairs independent rows, and retries only the failed row', async () => {
    const { app, store, loadSession } = fixture({ seed: store => {
      for (const id of ['child', 'root']) store.mark({ id, unread: true });
    } });
    loadSession.mockImplementation(async id => {
      if (id === 'root') throw new Error('temporarily unavailable');
      return { id, parentID: 'root' };
    });
    expect((await request(app).get('/api/yuri/session-unread')).status).toBe(503);
    expect(Object.keys(store.snapshot().sessions)).toEqual(['root']);
    loadSession.mockResolvedValue({ id: 'root', directory: '/project' });
    expect((await request(app).get('/api/yuri/session-unread')).body.sessions.root.unreadCount).toBe(1);
    expect(loadSession.mock.calls.map(([id]) => id)).toEqual(['child', 'root', 'root']);
  });

  it('removes prior attention when authoritative metadata makes a session hidden without a new completion', async () => {
    const { event, store, loadSession, changed } = fixture();
    await event('session.execution.succeeded');
    loadSession.mockResolvedValue({ id: 'one', metadata: { yuri: { worker: { parentSessionID: 'root' } } } });
    await event('session.metadata.updated');
    expect(store.snapshot().sessions.one).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    await event('session.execution.succeeded');
    expect(store.snapshot().sessions.one).toBeUndefined();
  });

  it('coalesces startup snapshots, caps identity reads at four, and performs no warm snapshot reads', async () => {
    const { app, loadSession } = fixture({ seed: store => {
      for (let i = 0; i < 24; i++) store.mark({ id: `session-${i}`, unread: true });
      store.mark({ id: 'already-read', unread: true });
      const revision = store.snapshot().sessions['already-read'].revision;
      store.mark({ id: 'already-read', unread: false, expectedRevision: revision });
    } });
    let active = 0;
    let peak = 0;
    loadSession.mockImplementation(async id => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { id, directory: '/project' };
    });
    const snapshots = await Promise.all([request(app).get('/api/yuri/session-unread'), request(app).get('/api/yuri/session-unread')]);
    expect(snapshots.map(result => result.status)).toEqual([200, 200]);
    expect(peak).toBe(4);
    expect(loadSession).toHaveBeenCalledTimes(24);
    await request(app).get('/api/yuri/session-unread');
    expect(loadSession).toHaveBeenCalledTimes(24);
  });

  it('returns retryable snapshot failure rather than waiting forever behind a failed lifecycle boundary', async () => {
    const { app, event, loadSession, store } = fixture({ seed: store => store.mark({ id: 'one', unread: true }) });
    loadSession.mockRejectedValue(new Error('offline'));
    void event('session.execution.started');
    expect((await request(app).get('/api/yuri/session-unread')).status).toBe(503);
    expect(store.snapshot().sessions.one.unreadCount).toBe(1);
  });

  it('keeps persisted unread and revision on cleanup write failure, then repairs only that row on retry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-unread-repair-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'state.sqlite');
    const store = createSessionUnreadStore({ dbPath });
    store.mark({ id: 'worker', unread: true });
    store.mark({ id: 'root', unread: true });
    const previous = store.snapshot();
    const loadSession = vi.fn(async id => ({ id, ...(id === 'worker' ? { parentID: 'root' } : {}) }));
    const runtime = createSessionUnreadRuntime({ store, loadSession });
    cleanup.push(() => runtime.close());
    const app = express();
    runtime.registerRoutes(app);
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(dbPath);
    cleanup.push(() => db.close());
    db.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON session_unread BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect((await request(app).get('/api/yuri/session-unread')).status).toBe(503);
    expect(store.snapshot()).toEqual(previous);
    db.exec('DROP TRIGGER reject_cleanup');
    expect(Object.keys((await request(app).get('/api/yuri/session-unread')).body.sessions)).toEqual(['root']);
    expect(loadSession.mock.calls.map(([id]) => id)).toEqual(['worker', 'root', 'worker']);
  });

  it('records completion with no clients, deduplicates succeeded/idle, and rearms on a new run', async () => {
    const { store, event, changed } = fixture();
    await event('session.execution.succeeded');
    await event('session.idle');
    expect(store.snapshot().sessions.one).toMatchObject({ unreadCount: 1, hasError: false, directory: '/project' });
    expect(changed).toHaveBeenCalledTimes(1);
    await event('session.execution.started');
    await event('session.execution.succeeded');
    expect(store.snapshot().sessions.one.unreadCount).toBe(2);
  });

  it('shares read/unread across clients and stale reads cannot erase newer manual marks or completions', async () => {
    const { app, event } = fixture();
    await event('session.execution.succeeded');
    const a = (await request(app).get('/api/yuri/session-unread')).body;
    const b = (await request(app).get('/api/yuri/session-unread')).body;
    expect(a).toEqual(b);
    const read = await request(app).put('/api/yuri/session-unread/one').send({ unread: false, expectedRevision: a.sessions.one.revision });
    expect(read.body.sessions.one.unreadCount).toBe(0);
    const manual = await request(app).put('/api/yuri/session-unread/one').send({ unread: true });
    expect(manual.body.sessions.one).toMatchObject({ unreadCount: 1, manual: true });
    const stale = await request(app).put('/api/yuri/session-unread/one').send({ unread: false, expectedRevision: b.sessions.one.revision });
    expect(stale.body).toEqual(manual.body);
    await event('session.execution.started');
    await event('session.execution.succeeded');
    const staleAgain = await request(app).put('/api/yuri/session-unread/one').send({ unread: false, expectedRevision: manual.body.sessions.one.revision });
    expect(staleAgain.body.sessions.one.unreadCount).toBe(2);
  });

  it('retains committed state and deduplication after a server restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-unread-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'state.sqlite');
    const first = createSessionUnreadStore({ dbPath });
    first.observe({ id: 'one', directory: '/project', kind: 'complete', sequence: 20 });
    first.mark({ id: 'two', unread: true, directory: '/other' });
    const expected = first.snapshot();
    first.close();
    const second = createSessionUnreadStore({ dbPath });
    cleanup.push(() => second.close());
    expect(second.snapshot()).toEqual(expected);
    second.observe({ id: 'one', kind: 'complete', sequence: 20 });
    second.observe({ id: 'one', kind: 'running', sequence: 19 });
    second.observe({ id: 'one', kind: 'complete', sequence: 21 });
    expect(second.snapshot()).toEqual(expected);
  });

  it('isolates failures, subagents and system sessions; new execution clears only its error', async () => {
    const { store, event, loadSession } = fixture();
    loadSession.mockImplementation(async id => ({ id, directory: '/project',
      ...(id === 'child' ? { parentID: 'root' } : {}),
      ...(id === 'system' ? { metadata: { yuri: { llm: { purpose: 'summary' } } } } : {}),
    }));
    await event('session.execution.failed');
    await event('session.error');
    await event('session.idle');
    await event('session.execution.failed', 'two');
    await event('session.execution.succeeded', 'child');
    await event('session.execution.succeeded', 'system');
    await event('session.execution.started', 'child');
    await event('session.execution.started', 'system');
    expect(Object.keys(store.snapshot().sessions).sort()).toEqual(['one', 'two']);
    expect(store.snapshot().sessions.one).toMatchObject({ unreadCount: 1, hasError: true });
    await event('session.execution.started');
    expect(store.snapshot().sessions.one).toMatchObject({ unreadCount: 0, hasError: false });
    expect(store.snapshot().sessions.two).toMatchObject({ unreadCount: 1, hasError: true });
  });

  it('skips 10000 streaming events without metadata reads, writes or revision bumps', async () => {
    const { runtime, store, loadSession, changed } = fixture();
    for (let i = 0; i < 10000; i++) {
      await runtime.processEvent({ type: 'message.part.updated', data: { sessionID: 'one' } });
    }
    expect(loadSession).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual({ revision: 0, sessions: {} });
  });

  it('rejects old and duplicate native boundaries even before the first completion', async () => {
    const { store, event } = fixture();
    await event('session.execution.started', 'one', 20, 20);
    await event('session.execution.succeeded', 'one', 10, 10);
    expect(store.snapshot().sessions.one.unreadCount).toBe(0);
    await event('session.execution.succeeded', 'one', 30, 30);
    await event('session.execution.started', 'one', 20, 20);
    await event('session.idle', 'one', 31, 31);
    expect(store.snapshot().sessions.one.unreadCount).toBe(1);
  });

  it('validates mutations and does not convert upstream failure into empty success', async () => {
    const { app, event, loadSession, store } = fixture();
    await event('session.execution.succeeded');
    const previous = store.snapshot();
    for (const body of [{}, { unread: 'yes' }, { unread: false }, { unread: false, expectedRevision: -1 }]) {
      expect((await request(app).put('/api/yuri/session-unread/one').send(body)).status).toBe(400);
    }
    loadSession.mockRejectedValue(new Error('unavailable'));
    expect((await request(app).put('/api/yuri/session-unread/one').send({ unread: true })).status).toBe(503);
    expect(store.snapshot()).toEqual(previous);
  });

  it('rolls back both state and revision when durable commit fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-unread-rollback-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'state.sqlite');
    const changed = vi.fn();
    const store = createSessionUnreadStore({ dbPath, onChanged: changed });
    cleanup.push(() => store.close());
    store.mark({ id: 'one', unread: true });
    const previous = store.snapshot();
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(dbPath);
    db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON session_unread BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect(() => store.mark({ id: 'one', unread: false, expectedRevision: 1 })).toThrow('write failed');
    expect(store.snapshot()).toEqual(previous);
    expect(changed).toHaveBeenCalledTimes(1);
    db.exec('DROP TRIGGER reject_write'); db.close();
    expect(store.mark({ id: 'one', unread: false, expectedRevision: 1 }).sessions.one.unreadCount).toBe(0);
  });

  it('retries a failed identity read in order without blocking other sessions', async () => {
    const { event, loadSession, store } = fixture({ retryMs: 5 });
    loadSession.mockRejectedValueOnce(new Error('temporary failure'));
    const first = event('session.execution.succeeded', 'one', 10, 10);
    const next = event('session.execution.started', 'one', 20, 20);
    const last = event('session.execution.succeeded', 'one', 30, 30);
    await event('session.execution.succeeded', 'two', 10, 10);
    expect(store.snapshot().sessions.two.unreadCount).toBe(1);
    await Promise.all([first, next, last]);
    expect(store.snapshot().sessions.one.unreadCount).toBe(2);
  });

  it('serializes a terminal identity read with the next run and deletes only the selected session', async () => {
    const { event, store, loadSession } = fixture();
    let release;
    loadSession.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const complete = event('session.execution.succeeded', 'one', 10, 10);
    const started = event('session.execution.started', 'one', 20, 20);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release({ id: 'one', title: '', directory: '/project' });
    await Promise.all([complete, started]);
    await event('session.execution.succeeded', 'one', 30, 30);
    await event('session.execution.succeeded', 'two');
    expect(store.snapshot().sessions.one.unreadCount).toBe(2);
    await event('session.deleted', 'one');
    expect(store.snapshot().sessions.one).toBeUndefined();
    expect(store.snapshot().sessions.two.unreadCount).toBe(1);
  });
});
