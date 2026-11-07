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
export type NotificationPreferences = Readonly<Partial<Record<NotificationPreferenceKey, boolean>>>;
const keys: readonly NotificationPreferenceKey[] = ['nativeNotificationsEnabled', ...notificationEventFields.map(field => field.key)];
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).ok === false || (value as Record<string, unknown>).success === false) throw new Error('notification_invalid_preferences');
  return value as Record<string, unknown>;
};
/** Ignore browser-only mode/templates without modifying them on the Host. Never copy arbitrary settings. */
export function notificationPreferences(value: unknown): NotificationPreferences {
  const data = object(value), result: Partial<Record<NotificationPreferenceKey, boolean>> = {};
  for (const key of keys) if (key in data) {
    if (typeof data[key] !== 'boolean') throw new Error('notification_invalid_preferences');
    result[key] = data[key];
  }
  return Object.freeze(result);
}
export function notificationPreferenceValue(snapshot: NotificationPreferences, key: NotificationPreferenceKey): boolean {
  return snapshot[key] ?? (key !== 'nativeNotificationsEnabled' && key !== 'notifyOnSubtasks');
}
function patch(value: NotificationPreferences): NotificationPreferences {
  if (Object.keys(value).some(key => !keys.includes(key as NotificationPreferenceKey))) throw new Error('notification_invalid_patch');
  return notificationPreferences(value);
}
const same = (a: NotificationScope, b: NotificationScope | null) => !!b && a.hostID === b.hostID && a.generation === b.generation;

/** One shared root/page transport: only snapshots returned by its successful, current GET may configure native. */
export function createNotificationSettingsTransport(input: {
  scope: () => NotificationScope | null; language: () => NotificationLanguage; call: NotificationCall;
  read: () => Promise<unknown>; write: (changes: NotificationPreferences) => Promise<unknown>;
}) {
  const delivery = createNotificationDelivery(input);
  let revision = 0;
  type Confirmation = { scope: NotificationScope; preferences: NotificationPreferences };
  let confirmed: Confirmation | null = null;
  let reading: { revision: number; scope: NotificationScope; language: NotificationLanguage; promise: Promise<NotificationPreferences> } | null = null;
  let configuring: { preferences: NotificationPreferences; revision: number; promise: Promise<void> } | null = null;
  const listeners = new Set<(value: Confirmation) => void>();
  const receipts = new WeakMap<NotificationPreferences, { revision: number; scope: NotificationScope; language: NotificationLanguage }>();
  function read(): Promise<NotificationPreferences> {
    const captured = input.scope(), language = input.language();
    if (!captured) return Promise.reject(new Error('notification_stale'));
    if (reading && reading.revision === revision && same(reading.scope, captured) && reading.language === language) return reading.promise;
    const ticket = ++revision;
    const promise = (async () => {
      const preferences = notificationPreferences(await input.read());
      if (revision !== ticket || !same(captured, input.scope()) || input.language() !== language) throw new Error('notification_stale');
      receipts.set(preferences, { revision: ticket, scope: { ...captured }, language });
      return preferences;
    })();
    reading = { revision: ticket, scope: captured, language, promise };
    const clear = () => { if (reading?.promise === promise) reading = null; };
    void promise.then(clear, clear);
    return promise;
  }
  function synchronize(preferences: NotificationPreferences): Promise<void> {
    const receipt = receipts.get(preferences);
    if (!receipt || receipt.revision !== revision || !same(receipt.scope, input.scope()) || receipt.language !== input.language()) return Promise.reject(new Error('notification_stale'));
    if (configuring?.preferences === preferences && configuring.revision === revision) return configuring.promise;
    const promise = (async () => {
      await delivery.configure(notificationConfiguration(receipt.scope.hostID, { ...preferences, notificationMode: 'hidden-only' }, input.language()));
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
    const captured = input.scope(), body = patch(changes);
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
  read: () => Promise<NotificationPreferences>; write: (changes: NotificationPreferences) => Promise<void>;
  synchronize: (snapshot: NotificationPreferences) => Promise<void>; current: () => boolean;
  changed: (state: NotificationPreferencesState) => void;
}) {
  let state: NotificationPreferencesState = { snapshot: null, draft: {}, busy: false, error: null, saved: false, pending: null, syncPending: false };
  let submitted: NotificationPreferences | null = null;
  const set = (change: Partial<NotificationPreferencesState>) => { if (input.current()) { state = { ...state, ...change }; input.changed(state); } };
  async function confirm() {
    let snapshot: NotificationPreferences;
    try { snapshot = await input.read(); }
    catch { set({ error: state.pending === 'acknowledged' ? 'syncPending' : state.pending ? 'saveUnconfirmed' : 'readFailed' }); return; }
    if (!input.current()) return;
    const expected = submitted;
    const matched = !expected || Object.entries(expected).every(([key, value]) => notificationPreferenceValue(snapshot, key as NotificationPreferenceKey) === value);
    const draft = { ...state.draft };
    if (matched && expected) for (const key of keys) if (key in expected && draft[key] === expected[key]) delete draft[key];
    submitted = null;
    set({ snapshot, draft, pending: null, syncPending: true, error: matched ? null : 'saveUnconfirmed' });
    try {
      await input.synchronize(snapshot);
      if (!input.current()) return;
      set({ syncPending: false, saved: !!expected && matched, error: matched ? null : 'saveUnconfirmed' });
    } catch { set({ error: 'syncPending' }); }
  }
  async function refresh() {
    if (state.busy || !input.current()) return;
    set({ busy: true, saved: false });
    try { await confirm(); } finally { set({ busy: false }); }
  }
  return {
    state: () => state,
    value: (key: NotificationPreferenceKey) => state.draft[key] ?? notificationPreferenceValue(state.snapshot ?? {}, key),
    adopt(snapshot: NotificationPreferences) {
      if (!input.current() || state.busy || state.pending) return;
      const draft = { ...state.draft };
      for (const key of keys) if (key in draft && draft[key] === notificationPreferenceValue(snapshot, key)) delete draft[key];
      set({ snapshot, draft, syncPending: false, error: state.error === 'readFailed' || state.error === 'syncPending' ? null : state.error });
    },
    edit(key: NotificationPreferenceKey, value: boolean) {
      if (!input.current() || !state.snapshot || state.busy || state.pending) return;
      const next = { ...state.draft, ...patch({ [key]: value }) };
      if (value === notificationPreferenceValue(state.snapshot, key)) delete next[key];
      set({ draft: next, saved: false });
    },
    refresh,
    async save() {
      if (state.busy || !input.current() || !state.snapshot) return;
      if (state.pending || state.syncPending) { await refresh(); return; }
      if (!Object.keys(state.draft).length) return;
      submitted = patch(state.draft);
      set({ busy: true, saved: false, error: null, pending: 'unknown' });
      try {
        try { await input.write(submitted); }
        catch { set({ error: 'saveUnconfirmed' }); return; }
        if (!input.current()) return;
        set({ pending: 'acknowledged' });
        await confirm();
      } finally { set({ busy: false }); }
    },
  };
}
