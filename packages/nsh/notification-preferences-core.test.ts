import { expect, it } from 'vitest';
import { createNotificationPreferencesController, createNotificationSettingsTransport, notificationPreferences, type NotificationPreferences } from './notification-preferences-core';
import type { NotificationScope } from './notification-core';

const scope = { hostID: 'host-a', generation: 2 };
function setup(initial: unknown = { nativeNotificationsEnabled: true, notifyOnError: false }, desktop = false) {
  let host = initial, failRead = false, failWrite = false, failSync = false;
  const calls: string[] = [], writes: NotificationPreferences[] = [], configured: unknown[] = [];
  const transport = createNotificationSettingsTransport({ scope: () => scope, language: () => 'en',
    desktop,
    read: async () => { calls.push('GET'); if (failRead) throw new Error('read'); return host; },
    write: async body => { calls.push('PUT'); writes.push(body); host = { ...notificationPreferences(host, desktop), ...body }; if (failWrite) throw new Error('unknown'); return { ok: true }; },
    call: async (name, body) => { calls.push(name); configured.push(body); if (failSync) throw new Error('native'); return { lease: 'test-lease' }; },
  });
  const controller = createNotificationPreferencesController({ ...transport, desktop, current: () => true, changed: () => {} });
  return { controller, transport, calls, writes, configured, setReadFailure: (value: boolean) => { failRead = value; }, setWriteFailure: (value: boolean) => { failWrite = value; }, setSyncFailure: (value: boolean) => { failSync = value; }, setHost: (value: unknown) => { host = value; } };
}
it('initializes once from a real snapshot, preserves every toggle and ignores hidden browser settings without sending defaults', async () => {
  const s = setup({ nativeNotificationsEnabled: true, notifyOnCompletion: false, notifyOnSubtasks: true, notifyOnError: false, notifyOnQuestion: false, notifyOnPermission: true, notifyOnScheduledTasks: false, notifyOnAssistants: true, notifyOnGoals: false, notificationMode: { malformedButIrrelevant: true }, notificationTemplates: { token: 'excluded' }, token: 'excluded' });
  await s.controller.refresh();
  expect(s.calls).toEqual(['GET', 'notification.configure']); expect(s.writes).toEqual([]);
  expect(s.controller.value('notifyOnSubtasks')).toBe(true); expect(s.controller.value('notifyOnGoals')).toBe(false);
  expect(s.configured[0]).toMatchObject({ enabled: true, mode: 'hidden-only', events: ['subtask', 'permission', 'assistant'] });
  expect(JSON.stringify(s.configured)).not.toMatch(/excluded|malformedButIrrelevant|notificationTemplates/);
  const count = s.calls.length; s.controller.edit('notifyOnError', true); expect(s.calls).toHaveLength(count);
  await s.controller.save();
  expect(s.calls.slice(count)).toEqual(['PUT', 'GET', 'notification.configure']);
  expect(s.writes).toEqual([{ notifyOnError: true }]); expect(s.controller.state().saved).toBe(true);
});
it('keeps the confirmed snapshot and unsaved draft when refresh fails; it never configures a fake empty response', async () => {
  const s = setup(); await s.controller.refresh(); const before = s.controller.state().snapshot;
  s.controller.edit('notifyOnError', true); s.setReadFailure(true); await s.controller.refresh();
  expect(s.controller.state().snapshot).toBe(before); expect(s.controller.state().draft).toEqual({ notifyOnError: true });
  expect(s.controller.state().error).toBe('readFailed'); expect(s.calls.filter(name => name === 'notification.configure')).toHaveLength(1);
  for (const value of [null, [], { success: false }, { notifyOnError: 'false' }]) expect(() => notificationPreferences(value)).toThrow();
});
it('does not repeat an acknowledged PUT after failed read-back or native configuration', async () => {
  const s = setup(); await s.controller.refresh(); s.controller.edit('notifyOnError', true); s.setReadFailure(true);
  await s.controller.save(); expect(s.controller.state().pending).toBe('acknowledged'); expect(s.controller.state().error).toBe('syncPending');
  await s.controller.save(); expect(s.writes).toHaveLength(1);
  s.setReadFailure(false); s.setSyncFailure(true); await s.controller.refresh();
  expect(s.controller.state().draft).toEqual({}); expect(s.controller.state().syncPending).toBe(true);
  s.setSyncFailure(false); await s.controller.save();
  expect(s.writes).toHaveLength(1); expect(s.controller.state().syncPending).toBe(false); expect(s.controller.state().error).toBeNull();
});
it('reconciles an unknown write before allowing an explicit retry and does not silently discard a conflicting draft', async () => {
  const s = setup(); await s.controller.refresh(); s.controller.edit('notifyOnError', true); s.setWriteFailure(true); await s.controller.save();
  expect(s.controller.state().pending).toBe('unknown'); expect(s.controller.state().saved).toBe(false);
  await s.controller.refresh(); expect(s.writes).toHaveLength(1); expect(s.controller.state().draft).toEqual({}); expect(s.controller.state().saved).toBe(true);
  s.setWriteFailure(false); s.controller.edit('notifyOnError', false); s.setReadFailure(true); await s.controller.save();
  s.setReadFailure(false); s.setHost({ nativeNotificationsEnabled: true, notifyOnError: true }); await s.controller.refresh();
  expect(s.controller.state().error).toBe('saveUnconfirmed'); expect(s.controller.state().draft).toEqual({ notifyOnError: false });
  expect(s.writes).toHaveLength(2); await s.controller.save(); expect(s.writes).toHaveLength(3);
});
it('fences stale Host/generation/language reads and only accepts native configuration from its own confirmed GET', async () => {
  let current: NotificationScope | null = scope, language: 'en' | 'ja' = 'en', resolve!: (value: unknown) => void;
  const nativeCalls: unknown[] = [];
  const transport = createNotificationSettingsTransport({ scope: () => current, language: () => language,
    read: () => new Promise(done => { resolve = done; }), write: async () => true, call: async (_name, body) => { nativeCalls.push(body); return { lease: 'lease-a' }; } });
  const first = transport.read(), joined = transport.read(); expect(first).toBe(joined);
  current = { ...scope, generation: 3 }; resolve({ nativeNotificationsEnabled: true }); await expect(first).rejects.toThrow('notification_stale');
  const second = transport.read(); language = 'ja'; resolve({}); await expect(second).rejects.toThrow('notification_stale');
  await expect(transport.synchronize(notificationPreferences({ nativeNotificationsEnabled: true }))).rejects.toThrow('notification_stale');
  expect(nativeCalls).toEqual([]);
  const third = transport.read(); resolve({ nativeNotificationsEnabled: true }); const snapshot = await third; await transport.synchronize(snapshot);
  expect(nativeCalls).toEqual([expect.objectContaining({ language: 'ja', enabled: true })]);
});
it('never publishes a stale controller completion after the page loses its captured scope', async () => {
  let valid = true, finish!: (value: NotificationPreferences) => void, published = 0, synchronized = 0;
  const controller = createNotificationPreferencesController({ current: () => valid, read: () => new Promise(done => { finish = done; }), write: async () => {}, synchronize: async () => { synchronized++; }, changed: () => { published++; } });
  const pending = controller.refresh(); const before = published; valid = false; finish(notificationPreferences({ nativeNotificationsEnabled: true })); await pending;
  expect(published).toBe(before); expect(synchronized).toBe(0);
});
it('coalesces a root/page native update of the same successful GET receipt and publishes one controlled confirmation', async () => {
  let finish!: (value: unknown) => void, calls = 0, confirmations = 0;
  const transport = createNotificationSettingsTransport({ scope: () => scope, language: () => 'en', read: async () => ({ nativeNotificationsEnabled: true, token: 'excluded' }), write: async () => true,
    call: () => { calls++; return new Promise(done => { finish = done; }); } });
  transport.onConfirmed(value => { confirmations++; expect(value).toEqual({ scope, preferences: { nativeNotificationsEnabled: true } }); });
  const snapshot = await transport.read(), first = transport.synchronize(snapshot), joined = transport.synchronize(snapshot);
  expect(first).toBe(joined); expect(calls).toBe(1); finish({ lease: 'confirmed-lease' }); await first;
  expect(confirmations).toBe(1);
});
it('adopts a confirmed root snapshot without reading, configuring or losing a different unsaved edit', async () => {
  const s = setup(); await s.controller.refresh(); s.controller.edit('notifyOnError', true);
  const before = s.calls.length;
  s.controller.adopt(notificationPreferences({ nativeNotificationsEnabled: false, notifyOnError: false, notifyOnGoals: false }));
  expect(s.calls).toHaveLength(before); expect(s.controller.state().draft).toEqual({ notifyOnError: true });
  expect(s.controller.value('nativeNotificationsEnabled')).toBe(false); expect(s.controller.value('notifyOnGoals')).toBe(false);
});

it('desktop honors the actual Host mode and saves only an edited mode through ACK/read-back/native configure', async () => {
  const s = setup({ nativeNotificationsEnabled: true, notificationMode: 'always', notificationTemplates: { title: 'must-not-deliver' } }, true);
  await s.controller.refresh(); expect(s.controller.mode()).toBe('always'); expect(s.configured[0]).toMatchObject({ mode: 'always' });
  expect(JSON.stringify(s.configured)).not.toContain('must-not-deliver');
  s.controller.editMode('hidden-only'); s.controller.editMode('always'); expect(s.controller.state().draft).toEqual({});
  s.controller.editMode('hidden-only'); await s.controller.save();
  expect(s.writes).toEqual([{ notificationMode: 'hidden-only' }]); expect(s.controller.mode()).toBe('hidden-only');
  expect(s.configured.at(-1)).toMatchObject({ mode: 'hidden-only' }); expect(s.controller.state().saved).toBe(true);
});

it('desktop mode read failure keeps the original snapshot/draft and an unknown ACK is reconciled without a second PUT', async () => {
  const s = setup({ nativeNotificationsEnabled: true, notificationMode: 'hidden-only' }, true); await s.controller.refresh();
  s.controller.editMode('always'); const before = s.controller.state().snapshot;
  s.setHost({ nativeNotificationsEnabled: true, notificationMode: 'invalid' }); await s.controller.refresh();
  expect(s.controller.state().snapshot).toBe(before); expect(s.controller.state().draft).toEqual({ notificationMode: 'always' });
  s.setHost({ nativeNotificationsEnabled: true, notificationMode: 'hidden-only' }); s.setWriteFailure(true); await s.controller.save();
  expect(s.controller.state().pending).toBe('unknown'); await s.controller.save();
  expect(s.writes).toHaveLength(1); expect(s.controller.mode()).toBe('always'); expect(s.controller.state().pending).toBeNull();
  expect(s.configured.at(-1)).toMatchObject({ mode: 'always' });
});

it('mobile retains hidden-only delivery, ignores the Web mode, and cannot write it through either controller or transport', async () => {
  const s = setup({ nativeNotificationsEnabled: true, notificationMode: 'always' }); await s.controller.refresh();
  expect(s.controller.mode()).toBe('hidden-only'); expect(s.configured.at(-1)).toMatchObject({ mode: 'hidden-only' });
  s.controller.editMode('always'); expect(s.controller.state().draft).toEqual({});
  await expect(s.transport.write({ notificationMode: 'always' })).rejects.toThrow('notification_invalid_patch');
  expect(s.writes).toEqual([]);
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function recovering() {
  let lane = 1, active = true, snapshot: NotificationPreferences = { nativeNotificationsEnabled: true, notifyOnError: false };
  let read = async () => snapshot, write = async (_changes: NotificationPreferences) => {}, synchronize = async (_value: NotificationPreferences) => {};
  const writes: NotificationPreferences[] = [], configured: NotificationPreferences[] = [];
  const controller = createNotificationPreferencesController({ current: () => active,
    captureCurrent: () => { const captured = lane; return () => active && lane === captured; },
    read: () => read(), write: changes => { writes.push(changes); return write(changes); },
    synchronize: value => { configured.push(value); return synchronize(value); }, changed: () => {},
  });
  return { controller, writes, configured, setSnapshot: (value: NotificationPreferences) => { snapshot = value; },
    setRead: (next: typeof read) => { read = next; }, setWrite: (next: typeof write) => { write = next; }, setSync: (next: typeof synchronize) => { synchronize = next; },
    pause() { active = false; controller.retire(); }, resume() { lane++; active = true; },
  };
}

it('releases an inactive read lane and rejects its late completion/finally while a replacement read is busy', async () => {
  const s = recovering(), first = deferred<NotificationPreferences>(), second = deferred<NotificationPreferences>();
  s.setRead(() => first.promise); const old = s.controller.refresh(); expect(s.controller.state().busy).toBe(true);
  s.pause(); expect(s.controller.state().busy).toBe(false); s.resume();
  s.setRead(() => second.promise); const next = s.controller.refresh();
  first.resolve({ nativeNotificationsEnabled: false }); await old;
  expect(s.controller.state().snapshot).toBeNull(); expect(s.controller.state().busy).toBe(true); expect(s.configured).toEqual([]);
  second.resolve({ nativeNotificationsEnabled: true }); await next;
  expect(s.controller.value('nativeNotificationsEnabled')).toBe(true); expect(s.controller.state().busy).toBe(false);
});

it('keeps an unresolved PUT journal through resume reads and late ACK, then reconciles without replay', async () => {
  const s = recovering(), ack = deferred<void>(); await s.controller.refresh(); s.controller.edit('notifyOnError', true);
  s.setWrite(() => ack.promise); const old = s.controller.save(); s.pause(); s.resume();
  await s.controller.refresh();
  expect(s.controller.state()).toMatchObject({ busy: false, pending: 'unknown', saved: false, draft: { notifyOnError: true } });
  await s.controller.save(); expect(s.writes).toEqual([{ notifyOnError: true }]);
  const before = s.controller.state(); ack.resolve(); await old;
  expect(s.controller.state()).toBe(before);
  s.setSnapshot({ nativeNotificationsEnabled: true, notifyOnError: true }); await s.controller.refresh();
  expect(s.controller.state()).toMatchObject({ pending: null, saved: true, draft: {}, busy: false }); expect(s.writes).toHaveLength(1);
});

it('does not clear a write journal using a GET dispatched before the old PUT settled, even when that GET finishes later', async () => {
  const s = recovering(), ack = deferred<void>(), read = deferred<NotificationPreferences>(); await s.controller.refresh();
  s.controller.edit('notifyOnError', true); s.setWrite(() => ack.promise); const old = s.controller.save(); s.pause(); s.resume();
  s.setRead(() => read.promise); const refresh = s.controller.refresh(); ack.resolve(); await old;
  read.resolve({ nativeNotificationsEnabled: true, notifyOnError: false }); await refresh;
  expect(s.controller.state()).toMatchObject({ pending: 'unknown', draft: { notifyOnError: true }, saved: false });
  s.setRead(async () => ({ nativeNotificationsEnabled: true, notifyOnError: true })); await s.controller.save();
  expect(s.writes).toHaveLength(1); expect(s.controller.state()).toMatchObject({ pending: null, draft: {}, saved: true });
});

it.each(['read-back', 'native-sync'] as const)('retains the %s recovery state and ignores old completions after repeated lane gaps', async stage => {
  const s = recovering(); await s.controller.refresh(); s.controller.edit('notifyOnError', true);
  const read = deferred<NotificationPreferences>(), sync = deferred<void>();
  if (stage === 'read-back') s.setRead(() => read.promise); else { s.setSnapshot({ nativeNotificationsEnabled: true, notifyOnError: true }); s.setSync(() => sync.promise); }
  const old = s.controller.save(); for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  expect(s.controller.state().busy).toBe(true); s.pause(); s.resume(); s.pause(); s.resume();
  s.setRead(async () => ({ nativeNotificationsEnabled: true, notifyOnError: true })); s.setSync(async () => {});
  await s.controller.refresh(); const before = s.controller.state();
  read.resolve({ nativeNotificationsEnabled: false, notifyOnError: false }); sync.resolve(); await old;
  expect(s.controller.state()).toBe(before); expect(s.controller.state()).toMatchObject({ pending: null, syncPending: false, draft: {}, busy: false });
  expect(s.controller.value('nativeNotificationsEnabled')).toBe(true); expect(s.writes).toHaveLength(1);
});
