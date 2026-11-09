import { describe, expect, it, vi } from 'vitest';
import { createErrorFeedback, feedbackErrorKey, feedbackGeometry, type ErrorFeedback } from './error-feedback';

const deferred = () => { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let value: ErrorFeedback | null = null;
  const actions = createErrorFeedback({ read: () => value, write: next => { value = next; } });
  return { actions, read: () => value };
}
describe('error feedback recovery contract', () => {
  it('dismisses only the captured notice, keeping its failed state and explicit recovery', async () => {
    const f = fixture(), retry = vi.fn(async () => {});
    f.actions.publish('Safe summary', () => true, retry);
    const first = f.read()!;
    f.actions.dismiss(first.id);
    expect(f.read()).toMatchObject({ visible: false, retry });
    expect(retry).not.toHaveBeenCalled();
    f.actions.publish('Second failure', () => true, retry);
    f.actions.dismiss(first.id);
    expect(f.read()?.visible).toBe(true);
    await f.actions.retry(f.read()!.id);
    expect(retry).toHaveBeenCalledTimes(1); expect(f.read()).toBeNull();
  });
  it('serializes repeated presses and retains a continuing failure for another explicit retry', async () => {
    const f = fixture(), wait = deferred(), retry = vi.fn(() => wait.promise);
    f.actions.publish('Safe summary', () => true, retry); const id = f.read()!.id;
    const pending = f.actions.retry(id); await f.actions.retry(id);
    expect(retry).toHaveBeenCalledTimes(1); expect(f.read()?.busy).toBe(true);
    wait.reject(new Error('private stack/token/path')); await pending;
    expect(f.read()).toMatchObject({ message: 'Safe summary', busy: false, visible: true });
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it('late failed retry cannot overwrite a newer error and late successful retry cannot clear it', async () => {
    for (const fail of [false, true]) {
      const f = fixture(), wait = deferred();
      f.actions.publish('First', () => true, () => wait.promise);
      const pending = f.actions.retry(f.read()!.id);
      f.actions.publish('New failure', () => true);
      if (fail) wait.reject(new Error('old')); else wait.resolve();
      await pending; expect(f.read()?.message).toBe('New failure');
    }
  });
  it('closing during a pending retry stays closed after its failure without clearing the failure', async () => {
    const f = fixture(), wait = deferred();
    f.actions.publish('Safe failure', () => true, () => wait.promise);
    const id = f.read()!.id, pending = f.actions.retry(id);
    f.actions.dismiss(id); wait.reject(new Error('late private failure')); await pending;
    expect(f.read()).toMatchObject({ id, visible: false, busy: false, message: 'Safe failure' });
  });
  it('retired owner cannot retry, publish or adopt a delayed retry completion', async () => {
    const f = fixture(), retry = vi.fn(async () => {}); let lease = 1;
    f.actions.publish('A lease 1', () => lease === 1, retry);
    const old = f.read()!.id; lease = 2;
    await f.actions.retry(old); expect(retry).not.toHaveBeenCalled();
    f.actions.publish('late old failure', () => lease === 1); expect(f.read()?.message).toBe('A lease 1');
    f.actions.retire(); lease = 3;
    f.actions.publish('A lease 3', () => lease === 3, retry);
    await f.actions.retry(old); expect(f.read()?.message).toBe('A lease 3');
  });
  it('provides no replay action for operations without an owner recovery callback', async () => {
    const f = fixture(); f.actions.publish('Unknown write outcome', () => true);
    const entry = f.read()!; await f.actions.retry(entry.id);
    expect(f.read()).toBe(entry); expect(entry.retry).toBeUndefined();
  });
  it('uses actual portrait, landscape and changing safe insets with bounded scroll space', () => {
    const portrait = feedbackGeometry({ height: 852, width: 393 }, { top: 59, bottom: 34, left: 0, right: 0 });
    expect(portrait).toMatchObject({ top: 75, left: 16, right: 16 }); expect(portrait.maxHeight).toBeCloseTo(436.2);
    const landscape = feedbackGeometry({ height: 393, width: 852 }, { top: 0, bottom: 21, left: 59, right: 59 });
    expect(landscape).toEqual({ top: 16, left: 146, right: 146, maxHeight: 204 });
    expect(feedbackGeometry({ height: 100, width: 393 }, { top: 90, bottom: 20, left: 0, right: 0 }).maxHeight).toBe(0);
  });
  it('classifies native denial, authorization and connection without exposing any raw text', () => {
    expect(feedbackErrorKey(Object.assign(new Error("nsh/host: 'connection.list' not granted: add it to capabilities.host /host/private bearer=secret"), { code: 'ERR_ACCESS_DENIED' }))).toBe('native.feedback.permission');
    expect(feedbackErrorKey({ status: 403, message: 'private' })).toBe('native.feedback.authorization');
    expect(feedbackErrorKey({ status: 503, message: 'private' })).toBe('native.feedback.connection');
    expect(feedbackErrorKey(new Error('private stack'))).toBe('native.feedback.operation');
  });
});
