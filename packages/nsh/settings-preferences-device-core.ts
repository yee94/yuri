export const deviceChatPreferenceDefaults = { allowPromptingSubagentSessions: false, collapsibleUserMessages: true, persistChatDraft: true } as const;
export type DeviceChatPreferenceKey = keyof typeof deviceChatPreferenceDefaults;
export type DeviceChatPreferences = { [K in DeviceChatPreferenceKey]: boolean };
export const deviceChatPreferenceKey = 'chat-preferences-v1';
export const isDeviceChatPreference = (key: string): key is DeviceChatPreferenceKey => Object.prototype.hasOwnProperty.call(deviceChatPreferenceDefaults, key);

/** Device-wide preferences, independent of Host settings and authentication. */
export function createDeviceChatPreferences(input: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<unknown>;
  changed: (value: DeviceChatPreferences | null) => void;
}) {
  let value: DeviceChatPreferences | null = null, flight: Promise<unknown> = Promise.resolve();
  const decode = (raw: string | null): DeviceChatPreferences => {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('device-preferences-invalid');
    const record = parsed as Record<string, unknown>, next: DeviceChatPreferences = { ...deviceChatPreferenceDefaults };
    for (const key of Object.keys(next) as DeviceChatPreferenceKey[]) {
      if (key in record && typeof record[key] !== 'boolean') throw new Error('device-preferences-invalid');
      if (typeof record[key] === 'boolean') next[key] = record[key];
    }
    return next;
  };
  const serialize = <T>(work: () => Promise<T>): Promise<T> => { const next = flight.then(work, work); flight = next; return next; };
  return {
    snapshot: () => value,
    load: () => serialize(async () => { const next = decode(await input.get(deviceChatPreferenceKey)); value = next; input.changed(next); return next; }),
    save: (patch: Partial<DeviceChatPreferences>) => serialize(async () => {
      for (const [key, item] of Object.entries(patch)) if (!isDeviceChatPreference(key) || typeof item !== 'boolean') throw new Error('device-preferences-invalid');
      const base = decode(await input.get(deviceChatPreferenceKey)), next = { ...base, ...patch };
      await input.set(deviceChatPreferenceKey, JSON.stringify(next));
      value = next; input.changed(next); return next;
    }),
  };
}
