import { expect, test, vi } from 'vitest';
import { createRetentionScheduler } from './settings-retention-scheduler';
import { createRetentionController } from './settings-retention-controller';
import { createHost } from './tests/settings-retention-host.js';

test('saved Host enablement never schedules destructive work without atomic server admission, including foreground recovery', async () => {
  vi.useFakeTimers();
  try {
    const host = createHost(), memory = new Map<string, string>();
    const controller = createRetentionController({ scope: 'synthetic', current: () => true, protectedIDs: () => new Set(), now: () => 200 * 86_400_000, storage: { getItem: async key => memory.get(key) ?? null, setItem: async (key, value) => { memory.set(key, value); } }, send: async (path, method = 'GET', body) => host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) }).body });
    await controller.load();
    const scheduler = createRetentionScheduler(controller, { now: () => 200 * 86_400_000, set: (delay, run) => setTimeout(run, delay), clear: timer => clearTimeout(timer) });
    expect(() => createRetentionScheduler(controller, { now: () => 0, set: () => 1, clear: () => {} })).toThrow('already owned');
    scheduler.update(true);
    expect(vi.getTimerCount()).toBe(0);
    await controller.save({ autoDeleteEnabled: true, autoDeleteAfterDays: 30, sessionRetentionAction: 'archive' });
    for (let index = 0; index < 100; index++) scheduler.update(true);
    expect(controller.snapshot()).toMatchObject({ hostSynced: true, preferences: { autoDeleteEnabled: true }, admission: 'server-atomic-required', error: 'admission' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7999);
    expect(host.call('retention.fixture.audit').catalogReads).toBe(0);
    scheduler.update(false);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.update(true);
    await controller.load();
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    expect(host.call('retention.fixture.audit')).toMatchObject({ archiveWrites: 0, deleteWrites: 0, catalogReads: 0 });
    expect(vi.getTimerCount()).toBe(0);
    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
