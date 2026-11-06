import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createImportStore } from './store.js';

let directory; let store;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-import-store-')); });
afterEach(async () => { store?.close(); await fs.rm(directory, { recursive: true, force: true }); });

test('old receipts migrate without loss; phase progress and discovered totals survive restart', () => {
  const file = path.join(directory, 'receipts.sqlite'); const old = new Database(file);
  old.exec(`CREATE TABLE import_job (id TEXT PRIMARY KEY, owner TEXT NOT NULL, runtime TEXT NOT NULL,
    state TEXT NOT NULL, total INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE import_receipt (job TEXT NOT NULL, position INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(job, position));
    INSERT INTO import_job VALUES ('old', 'owner', 'runtime', 'completed', 1, 1);
    INSERT INTO import_receipt VALUES ('old', 0, '{"key":"old-item","status":"imported"}');`);
  old.close(); store = createImportStore(file);
  expect(store.get('old', 'owner', 'runtime')).toMatchObject({ state: 'completed', completed: 1, results: [{ key: 'old-item', status: 'imported' }] });
  store.create('new', 'owner', 'runtime', 0);
  store.progress('new', { phase: 'validating', completed: 2, total: 10 });
  expect(store.get('new', 'owner', 'runtime')).toMatchObject({ total: 0, completed: 0, progress: { phase: 'validating', completed: 2, total: 10 } });
  store.progress('new', { phase: 'importing', completed: 1, total: 12 }, 12);
  store.append('new', 0, { key: 'item', status: 'imported' });
  store.close(); store = createImportStore(file);
  expect(store.latest('owner', 'runtime')).toMatchObject({ id: 'new', state: 'interrupted', total: 12, completed: 1,
    progress: { phase: 'importing', completed: 1, total: 12 } });
  expect(store.get('old', 'owner', 'runtime').state).toBe('completed');
  expect(store.get('old', 'owner', 'runtime').resumable).toBe(false);
});

test('private retry selection survives restart; unfinished jobs are scoped and restarting resets only that receipt', () => {
  const file = path.join(directory, 'jobs.sqlite'); store = createImportStore(file);
  const selection = { sources: ['claude'], directory: '/workspace' };
  store.create('one', 'owner', 'runtime', 357, selection);
  store.append('one', 0, { status: 'imported', sessionID: 'saved' });
  store.finish('one', 'interrupted');
  store.create('two', 'owner', 'runtime', 0, selection);
  store.create('other', 'other', 'runtime', 0, selection);
  store.create('runtime', 'owner', 'other', 0, selection);
  store.close(); store = createImportStore(file);
  expect(store.request('one', 'owner', 'runtime')).toEqual(selection);
  expect(store.request('one', 'other', 'runtime')).toBeNull();
  const jobs = store.unfinished('owner', 'runtime');
  expect(jobs.map((job) => job.id)).toEqual(['one', 'two']);
  expect(jobs[0]).toMatchObject({ resumable: true, completed: 1, results: [] });
  expect(JSON.stringify(jobs)).not.toContain('/workspace');
  expect(store.get('one', 'owner', 'runtime')).not.toHaveProperty('request');
  store.restart('one', selection);
  expect(store.get('one', 'owner', 'runtime')).toMatchObject({ state: 'running', completed: 0, total: 0 });
  expect(store.get('two', 'owner', 'runtime')).toMatchObject({ state: 'interrupted' });
  store.finish('one', 'completed');
  expect(store.unfinished('owner', 'runtime').map((job) => job.id)).toEqual(['two']);
});

test('partial imports leave unfinished lists but keep durable failure receipts across restart', () => {
  const file = path.join(directory, 'partial.sqlite'); store = createImportStore(file);
  store.create('partial', 'owner', 'runtime', 1, { sources: ['claude'] });
  store.append('partial', 0, { key: 'bad', status: 'failed', code: 'empty_transcript' });
  store.finish('partial', 'partial');
  expect(store.unfinished('owner', 'runtime')).toEqual([]);
  expect(store.get('partial', 'owner', 'runtime')).toMatchObject({ state: 'partial', completed: 1, resumable: false, results: [{ code: 'empty_transcript' }] });
  store.close(); store = createImportStore(file);
  expect(store.unfinished('owner', 'runtime')).toEqual([]);
  expect(store.get('partial', 'owner', 'runtime').results).toHaveLength(1);
});

test('dismissal is scoped, rejects active jobs, survives restart and retains receipts', () => {
  const file = path.join(directory, 'dismiss.sqlite'); store = createImportStore(file);
  store.create('active', 'owner', 'runtime', 0);
  store.create('failed', 'owner', 'runtime', 357);
  store.append('failed', 0, { status: 'imported', sessionID: 'saved' }); store.finish('failed', 'interrupted');
  expect(store.dismiss('active', 'owner', 'runtime')).toBe(false);
  expect(store.dismiss('failed', 'other', 'runtime')).toBe(false);
  expect(store.dismiss('failed', 'owner', 'other')).toBe(false);
  expect(store.dismiss('failed', 'owner', 'runtime')).toBe(true);
  expect(store.get('failed', 'owner', 'runtime')).toMatchObject({ dismissed: true, completed: 1, results: [{ sessionID: 'saved' }] });
  expect(store.unfinished('owner', 'runtime').map((job) => job.id)).toEqual(['active']);
  expect(store.latest('owner', 'runtime').id).toBe('active');
  store.close(); store = createImportStore(file);
  expect(store.get('failed', 'owner', 'runtime')).toMatchObject({ dismissed: true, completed: 1 });
  expect(store.unfinished('owner', 'runtime').map((job) => job.id)).toEqual(['active']);
});
