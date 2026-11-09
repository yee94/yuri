import { expect, test } from 'vitest';
import { createDeviceChatPreferences, deviceChatPreferenceDefaults } from './settings-preferences-device-core';

test('device defaults and explicit false round-trip without any Host contract', async () => {
  let raw: string | null = null;
  const store = createDeviceChatPreferences({ get: async () => raw, set: async (_key, next) => { raw = next; }, changed: () => {} });
  expect(await store.load()).toEqual(deviceChatPreferenceDefaults);
  await store.save({ persistChatDraft: false, allowPromptingSubagentSessions: true });
  expect(await store.load()).toEqual({ persistChatDraft: false, collapsibleUserMessages: true, allowPromptingSubagentSessions: true });
  expect(JSON.parse(raw!)).toEqual(store.snapshot());
});
test('serialized writes merge latest persisted siblings and failed writes keep the valid consumer snapshot', async () => {
  let raw: string | null = null, fail = false;
  const store = createDeviceChatPreferences({ get: async () => raw, set: async (_key, next) => { if (fail) throw new Error('disk'); raw = next; }, changed: () => {} });
  await store.load();
  await Promise.all([store.save({ collapsibleUserMessages: false }), store.save({ persistChatDraft: false })]);
  expect(store.snapshot()).toMatchObject({ collapsibleUserMessages: false, persistChatDraft: false });
  fail = true; await expect(store.save({ persistChatDraft: true })).rejects.toThrow();
  expect(store.snapshot()?.persistChatDraft).toBe(false);
  raw = '{bad'; await expect(store.load()).rejects.toThrow();
  expect(store.snapshot()?.persistChatDraft).toBe(false);
});
