import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { queryClient } from '@/lib/queryRuntime';
import { useUIStore } from '@/stores/useUIStore';
import { startAppearanceAutoSave } from './appearanceAutoSave';
import { invalidateSettingsCache, syncDesktopSettings, updateDesktopSettings } from './persistence';

const notificationToggles = [
  ['nativeNotificationsEnabled', 'setNativeNotificationsEnabled'],
  ['notifyOnSubtasks', 'setNotifyOnSubtasks'],
  ['notifyOnCompletion', 'setNotifyOnCompletion'],
  ['notifyOnError', 'setNotifyOnError'],
  ['notifyOnQuestion', 'setNotifyOnQuestion'],
  ['notifyOnPermission', 'setNotifyOnPermission'],
  ['notifyOnScheduledTasks', 'setNotifyOnScheduledTasks'],
  ['notifyOnAssistants', 'setNotifyOnAssistants'],
  ['notifyOnGoals', 'setNotifyOnGoals'],
] as const;

let savedSettings: SettingsPayload;
const save = vi.fn(async (changes: Partial<SettingsPayload>): Promise<SettingsPayload> => {
  savedSettings = { ...savedSettings, ...changes };
  return { ...savedSettings };
});

beforeAll(() => {
  startAppearanceAutoSave();
});

beforeEach(async () => {
  vi.useFakeTimers();
  invalidateSettingsCache();
  queryClient.clear();
  savedSettings = Object.fromEntries(notificationToggles.map(([field]) => [field, true]));
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: {
      load: async () => ({ settings: { ...savedSettings }, source: 'web' }),
      save,
    },
  } as unknown as RuntimeAPIs);
  await syncDesktopSettings();
  await vi.advanceTimersByTimeAsync(500);
  save.mockClear();
});

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(500);
  registerRuntimeAPIs(null);
  queryClient.clear();
  vi.useRealTimers();
});

describe('notification preference auto-save', () => {
  test.each(notificationToggles)('%s stays disabled after another settings save and reload', async (field, setter) => {
    useUIStore.getState()[setter](false);
    await vi.advanceTimersByTimeAsync(500);

    const unrelatedSave = updateDesktopSettings({ pwaAppName: 'Test app' });
    await vi.advanceTimersByTimeAsync(500);
    await unrelatedSave;
    invalidateSettingsCache();
    await syncDesktopSettings();

    expect({ persisted: savedSettings[field], displayed: useUIStore.getState()[field] }).toEqual({
      persisted: false,
      displayed: false,
    });
    expect(save).toHaveBeenCalledWith({ [field]: false });

    useUIStore.getState()[setter](true);
    await vi.advanceTimersByTimeAsync(500);
    expect(savedSettings[field]).toBe(true);
  });

  test('unrelated UI updates never save notification preferences', async () => {
    for (let index = 0; index < 50; index += 1) {
      useUIStore.getState().setImagePreviewOpen(index % 2 === 0);
    }
    await vi.advanceTimersByTimeAsync(500);

    expect(save).not.toHaveBeenCalled();
  });
});
