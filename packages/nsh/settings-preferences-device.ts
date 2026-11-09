import { signal, Storage } from 'nsh';
import { createDeviceChatPreferences, type DeviceChatPreferences } from './settings-preferences-device-core';

export const deviceChatPreferences = signal<DeviceChatPreferences | null>(null);
export const deviceChatPreferenceStore = createDeviceChatPreferences({
  get: key => Storage.getItem(key), set: (key, value) => Storage.setItem(key, value), changed: value => deviceChatPreferences.set(value),
});
