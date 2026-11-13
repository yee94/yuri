import { expect, it, vi } from 'vitest';
import { createRemoteWatchReconciler } from './remote-watch-reconciler.js';

const watch = (id, hostId = 'host') => ({ sessionID: id, target: { hubId: 'hub', hostId, instanceId: `instance-${hostId}` } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

it('coalesces 50 workers and 50 in-flight tips into one initial and one trailing batch', async () => {
  const entered = deferred(), finish = deferred();
  let current;
  const read = vi.fn(async (_batch, isCurrent) => {
    current = isCurrent;
    if (read.mock.calls.length === 1) { entered.resolve(); await finish.promise; }
  });
  const scheduler = createRemoteWatchReconciler(read);
  const workers = Array.from({ length: 50 }, (_, i) => watch(`session-${i}`));
  const pending = workers.map((worker) => scheduler.reconcile(worker));
  await entered.promise;
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][0]).toHaveLength(50);
  for (let i = 0; i < 50; i++) scheduler.reconcile(workers[0], true);
  expect(current(workers[0])).toBe(false);
  expect(current(workers[1])).toBe(true);
  finish.resolve();
  await Promise.all(pending);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1][0]).toEqual([workers[0]]);
  await scheduler.reconcile(workers[0]);
  expect(read).toHaveBeenCalledTimes(3);
  scheduler.close();
});

it('ordinary concurrent demand shares in-flight work; a new running event fences the older read', async () => {
  const entered = deferred(), finish = deferred();
  const worker = watch('same');
  let current;
  const read = vi.fn(async (_batch, isCurrent) => {
    current = isCurrent;
    if (read.mock.calls.length === 1) { entered.resolve(); await finish.promise; }
  });
  const scheduler = createRemoteWatchReconciler(read);
  scheduler.invalidate(worker);
  expect(read).not.toHaveBeenCalled();
  const first = scheduler.reconcile(worker);
  await entered.promise;
  for (let i = 0; i < 50; i++) expect(scheduler.reconcile(worker)).toBe(first);
  expect(current(worker)).toBe(true);
  scheduler.invalidate(worker);
  expect(current(worker)).toBe(false);
  finish.resolve(); await first;
  expect(read).toHaveBeenCalledTimes(2);
});

it('isolates equal session IDs across hosts and does not let a failed/blocked host stop its sibling', async () => {
  const entered = deferred(), finish = deferred();
  const read = vi.fn(async (batch) => {
    if (batch[0].target.hostId === 'a') { entered.resolve(); await finish.promise; throw new Error('offline'); }
  });
  const scheduler = createRemoteWatchReconciler(read);
  const a = scheduler.reconcile(watch('same', 'a'));
  await entered.promise;
  await scheduler.reconcile(watch('same', 'b'));
  expect(read).toHaveBeenCalledTimes(2);
  finish.resolve(); await a;
  await scheduler.reconcile(watch('same', 'a'));
  expect(read).toHaveBeenCalledTimes(3);
  scheduler.close();
  await scheduler.reconcile(watch('same'));
  expect(read).toHaveBeenCalledTimes(3);
});

it('shutdown invalidates an in-flight result and drops queued rereads', async () => {
  const entered = deferred(), finish = deferred();
  let current;
  const read = vi.fn(async (_batch, isCurrent) => { current = isCurrent; entered.resolve(); await finish.promise; });
  const scheduler = createRemoteWatchReconciler(read);
  const worker = watch('same');
  const pending = scheduler.reconcile(worker);
  await entered.promise;
  scheduler.reconcile(worker, true);
  scheduler.close();
  expect(current(worker)).toBe(false);
  finish.resolve(); await pending;
  expect(read).toHaveBeenCalledTimes(1);
});
