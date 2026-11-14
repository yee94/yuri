import { signal } from 'nsh';
import { list, record, request, textOf, unwrap } from './host';

/** The Host's settings document (`GET /api/config/settings`). */
export type SettingsDocument = Record<string, unknown>;

const state = {
  settings: signal<SettingsDocument | null>(null),
  loading: signal(false),
  error: signal(''),
};

export const settingsDocument = () => state.settings();
export const settingsLoading = () => state.loading();
export const settingsError = () => state.error();

export const settingsText = (key: string): string => textOf(state.settings()?.[key]);
export const settingsFlag = (key: string, fallback = false): boolean => {
  const value = state.settings()?.[key];
  return typeof value === 'boolean' ? value : fallback;
};
export const settingsNumber = (key: string, fallback = 0): number => {
  const value = state.settings()?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};
export const settingsRows = (key: string) => list(state.settings()?.[key]);

export async function loadSettings(force = false): Promise<void> {
  if (!force && state.settings() && !state.error()) return;
  state.loading.set(true);
  state.error.set('');
  try {
    state.settings.set(record(unwrap(await request('/api/config/settings'))));
  } catch (error) {
    state.error.set(error instanceof Error ? error.message : String(error));
  } finally {
    state.loading.set(false);
  }
}

export async function saveSettings(patch: SettingsDocument): Promise<boolean> {
  state.error.set('');
  const previous = state.settings();
  state.settings.set({ ...(previous ?? {}), ...patch });
  try {
    const saved = record(unwrap(await request('/api/config/settings', 'PUT', patch)));
    state.settings.set({ ...(previous ?? {}), ...patch, ...saved });
    return true;
  } catch (error) {
    state.settings.set(previous);
    state.error.set(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function reloadOpenCode(): Promise<void> {
  await request('/api/config/reload', 'POST', {});
}
