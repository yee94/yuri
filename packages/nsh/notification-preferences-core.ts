import { createNotificationDelivery, notificationConfiguration, type NotificationCall, type NotificationLanguage, type NotificationScope } from './notification-core';

export const notificationEventFields = [
  { key: 'notifyOnCompletion', title: 'settings.notifications.page.events.completionLabel' },
  { key: 'notifyOnSubtasks', title: 'settings.notifications.page.events.subtaskLabel' },
  { key: 'notifyOnError', title: 'settings.notifications.page.events.errorLabel' },
  { key: 'notifyOnQuestion', title: 'settings.notifications.page.events.questionLabel' },
  { key: 'notifyOnPermission', title: 'settings.notifications.page.events.permissionLabel' },
  { key: 'notifyOnScheduledTasks', title: 'settings.notifications.page.events.scheduledTasksLabel' },
  { key: 'notifyOnAssistants', title: 'settings.notifications.page.events.assistantsLabel' },
  { key: 'notifyOnGoals', title: 'settings.notifications.page.events.goalsLabel' },
] as const;
export type NotificationPreferenceKey = 'nativeNotificationsEnabled' | typeof notificationEventFields[number]['key'];
export type NotificationMode = 'always' | 'hidden-only';
export type NotificationPreferences = Readonly<Partial<Record<NotificationPreferenceKey, boolean>> & { notificationMode?: NotificationMode }>;
const keys: readonly NotificationPreferenceKey[] = ['nativeNotificationsEnabled', ...notificationEventFields.map(field => field.key)];
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).ok === false || (value as Record<string, unknown>).success === false) throw new Error('notification_invalid_preferences');
  return value as Record<string, unknown>;
};
/** Mobile ignores Web mode; both platforms exclude templates and arbitrary settings. */
export function notificationPreferences(value: unknown, desktop = false): NotificationPreferences {
  const data = object(value), result: Partial<Record<NotificationPreferenceKey, boolean>> & { notificationMode?: NotificationMode } = {};
  for (const key of keys) if (key in data) {
    if (typeof data[key] !== 'boolean') throw new Error('notification_invalid_preferences');
    result[key] = data[key];
  }
  if (desktop && data.notificationMode !== undefined) {
    if (data.notificationMode !== 'always' && data.notificationMode !== 'hidden-only') throw new Error('notification_invalid_preferences');
    result.notificationMode = data.notificationMode;
  }
  return Object.freeze(result);
}
export function notificationPreferenceValue(snapshot: NotificationPreferences, key: NotificationPreferenceKey): boolean {
  return snapshot[key] ?? (key !== 'nativeNotificationsEnabled' && key !== 'notifyOnSubtasks');
}
function patch(value: NotificationPreferences, desktop = false): NotificationPreferences {
  if (Object.keys(value).some(key => !keys.includes(key as NotificationPreferenceKey) && !(desktop && key === 'notificationMode'))) throw new Error('notification_invalid_patch');
  return notificationPreferences(value, desktop);
}
const same = (a: NotificationScope, b: NotificationScope | null) => !!b && a.hostID === b.hostID && a.generation === b.generation;

/** One shared root/page transport: only snapshots returned by its successful, current GET may configure native. */
export function createNotificationSettingsTransport(input: {
  scope: () => NotificationScope | null; language: () => NotificationLanguage; call: NotificationCall;
  read: () => Promise<unknown>; write: (changes: NotificationPreferences) => Promise<unknown>;
  desktop?: boolean;
}) {
  const delivery = createNotificationDelivery(input);
  let revision = 0;
  type Confirmation = { scope: NotificationScope; preferences: NotificationPreferences };
  let confirmed: Confirmation | null = null;
  let reading: { revision: number; scope: NotificationScope; language: NotificationLanguage; current: () => boolean; promise: Promise<NotificationPreferences> } | null = null;
  let configuring: { preferences: NotificationPreferences; revision: number; promise: Promise<void> } | null = null;
  const listeners = new Set<(value: Confirmation) => void>();
  const receipts = new WeakMap<NotificationPreferences, { revision: number; scope: NotificationScope; language: NotificationLanguage }>();
  function read(current: () => boolean = () => true): Promise<NotificationPreferences> {
    const captured = input.scope(), language = input.language();
    if (!captured || !current()) return Promise.reject(new Error('notification_stale'));
    if (reading && reading.current() && reading.revision === revision && same(reading.scope, captured) && reading.language === language) return reading.promise;
    const ticket = ++revision;
    const promise = (async () => {
      const preferences = notificationPreferences(await input.read(), input.desktop);
      if (!current() || revision !== ticket || !same(captured, input.scope()) || input.language() !== language) throw new Error('notification_stale');
      receipts.set(preferences, { revision: ticket, scope: { ...captured }, language });
      return preferences;
    })();
    reading = { revision: ticket, scope: captured, language, current, promise };
    const clear = () => { if (reading?.promise === promise) reading = null; };
    void promise.then(clear, clear);
    return promise;
  }
  function synchronize(preferences: NotificationPreferences): Promise<void> {
    const receipt = receipts.get(preferences);
    if (!receipt || receipt.revision !== revision || !same(receipt.scope, input.scope()) || receipt.language !== input.language()) return Promise.reject(new Error('notification_stale'));
    if (configuring?.preferences === preferences && configuring.revision === revision) return configuring.promise;
    const promise = (async () => {
      await delivery.configure(notificationConfiguration(receipt.scope.hostID, { ...preferences, notificationMode: input.desktop ? preferences.notificationMode ?? 'hidden-only' : 'hidden-only' }, input.language()));
      if (receipt.revision !== revision || !same(receipt.scope, input.scope()) || receipt.language !== input.language()) throw new Error('notification_stale');
      confirmed = { scope: receipt.scope, preferences };
      listeners.forEach(listener => listener(confirmed!));
    })();
    configuring = { preferences, revision, promise };
    const clear = () => { if (configuring?.promise === promise) configuring = null; };
    void promise.then(clear, clear);
    return promise;
  }
  async function write(changes: NotificationPreferences) {
    const captured = input.scope(), body = patch(changes, input.desktop);
    if (!captured || !Object.keys(body).length) throw new Error('notification_invalid_patch');
    ++revision; delivery.invalidate();
    const result = await input.write(body);
    if (!same(captured, input.scope())) throw new Error('notification_stale');
    if (result !== undefined && result !== null && result !== true) object(result);
  }
  return { delivery, scope: input.scope, read, synchronize, write,
    confirmed: () => confirmed && same(confirmed.scope, input.scope()) ? confirmed : null,
    onConfirmed(listener: (value: Confirmation) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refresh() { const preferences = await read(); await synchronize(preferences); return preferences; },
    retireReads() { ++revision; },
    invalidate() { ++revision; delivery.invalidate(); },
  };
}

export type NotificationPreferencesState = {
  snapshot: NotificationPreferences | null; draft: NotificationPreferences; busy: boolean;
  error: 'readFailed' | 'saveUnconfirmed' | 'syncPending' | null; saved: boolean;
  pending: 'unknown' | 'acknowledged' | null; syncPending: boolean;
};
/** ACK, read-back and native synchronization are separate. Retrying synchronization never replays a write. */
export function createNotificationPreferencesController(input: {
  read: (current?: () => boolean) => Promise<NotificationPreferences>; write: (changes: NotificationPreferences) => Promise<void>;
  synchronize: (snapshot: NotificationPreferences) => Promise<void>; current: () => boolean;
  captureCurrent?: () => () => boolean;
  desktop?: boolean;
  changed: (state: NotificationPreferencesState) => void;
}) {
  let state: NotificationPreferencesState = { snapshot: null, draft: {}, busy: false, error: null, saved: false, pending: null, syncPending: false };
  let submitted: NotificationPreferences | null = null;
  let revision = 0, writeInFlight = false;
  const set = (change: Partial<NotificationPreferencesState>) => { if (input.current()) { state = { ...state, ...change }; input.changed(state); } };
  function capture() {
    const ticket = ++revision, current = input.captureCurrent?.() ?? input.current;
    return () => ticket === revision && current() && input.current();
  }
  async function confirm(valid: () => boolean) {
    const readDuringWrite = writeInFlight;
    let snapshot: NotificationPreferences;
    try { snapshot = await input.read(valid); }
    catch { if (valid()) set({ error: state.pending === 'acknowledged' ? 'syncPending' : state.pending ? 'saveUnconfirmed' : 'readFailed' }); return; }
    if (!valid()) return;
    const expected = submitted;
    const matched = !expected || Object.entries(expected).every(([key, value]) => (key === 'notificationMode' ? snapshot.notificationMode ?? 'hidden-only' : notificationPreferenceValue(snapshot, key as NotificationPreferenceKey)) === value);
    const draft = { ...state.draft };
    const settled = !readDuringWrite && !writeInFlight;
    if (settled && matched && expected) for (const key of [...keys, 'notificationMode'] as const) if (key in expected && draft[key] === expected[key]) delete draft[key];
    if (settled) submitted = null;
    set({ snapshot, draft, pending: settled ? null : state.pending, syncPending: true, error: matched && settled ? null : 'saveUnconfirmed' });
    try {
      await input.synchronize(snapshot);
      if (!valid()) return;
      set({ syncPending: false, saved: settled && !!expected && matched, error: matched && settled ? null : 'saveUnconfirmed' });
    } catch { if (valid()) set({ error: 'syncPending' }); }
  }
  async function refresh() {
    if (state.busy || !input.current()) return;
    const valid = capture();
    set({ busy: true, saved: false });
    try { await confirm(valid); } finally { if (valid()) set({ busy: false }); }
  }
  return {
    state: () => state,
    retire() {
      ++revision;
      state = { ...state, busy: false, saved: false, error: state.pending ? 'saveUnconfirmed' : state.syncPending ? 'syncPending' : state.error };
      input.changed(state);
    },
    value: (key: NotificationPreferenceKey) => state.draft[key] ?? notificationPreferenceValue(state.snapshot ?? {}, key),
    mode: (): NotificationMode => state.draft.notificationMode ?? state.snapshot?.notificationMode ?? 'hidden-only',
    adopt(snapshot: NotificationPreferences) {
      if (!input.current() || state.busy || state.pending) return;
      const draft = { ...state.draft };
      for (const key of keys) if (key in draft && draft[key] === notificationPreferenceValue(snapshot, key)) delete draft[key];
      if (draft.notificationMode === (snapshot.notificationMode ?? 'hidden-only')) delete draft.notificationMode;
      set({ snapshot, draft, syncPending: false, error: state.error === 'readFailed' || state.error === 'syncPending' ? null : state.error });
    },
    edit(key: NotificationPreferenceKey, value: boolean) {
      if (!input.current() || !state.snapshot || state.busy || state.pending) return;
      const next = { ...state.draft, ...patch({ [key]: value }) };
      if (value === notificationPreferenceValue(state.snapshot, key)) delete next[key];
      set({ draft: next, saved: false });
    },
    editMode(value: NotificationMode) {
      if (!input.desktop || !input.current() || !state.snapshot || state.busy || state.pending) return;
      const next = { ...state.draft, ...patch({ notificationMode: value }, true) };
      if (value === (state.snapshot.notificationMode ?? 'hidden-only')) delete next.notificationMode;
      set({ draft: next, saved: false });
    },
    refresh,
    async save() {
      if (state.busy || !input.current() || !state.snapshot) return;
      if (state.pending || state.syncPending) { await refresh(); return; }
      if (!Object.keys(state.draft).length) return;
      const valid = capture();
      submitted = patch(state.draft, input.desktop);
      set({ busy: true, saved: false, error: null, pending: 'unknown' });
      try {
        writeInFlight = true;
        try { await input.write(submitted); }
        catch { if (valid()) set({ error: 'saveUnconfirmed' }); return; }
        finally { writeInFlight = false; }
        if (!valid()) return;
        set({ pending: 'acknowledged' });
        await confirm(valid);
      } finally { if (valid()) set({ busy: false }); }
    },
  };
}
