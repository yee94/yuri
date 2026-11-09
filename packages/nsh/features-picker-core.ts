import { pickerPreferences, preferenceUpdate, type ModelRef } from './chat-models-helpers';
import { record, type Row } from './model';

/** Draft selection is local. Only the existing global favorite/recent preferences are written. */
export function createFeaturePicker(options: {
  current: () => boolean; changed: () => void; select: (value: ModelRef) => void; close: () => void;
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>;
}) {
  let preferences: Row = {}, loaded = false, busy = false, error = '', serial = 0;
  let pending: { patch: Row; close: boolean } | undefined;
  let retryable: (() => Promise<void>) | undefined;
  const publish = () => options.changed();
  const settings = (value: unknown) => {
    const parsed = pickerPreferences(value);
    if (!parsed || parsed.failed === true || parsed.partial === true || parsed.complete === false) throw new Error('invalid-model-preferences');
    return parsed;
  };
  async function load() {
    if (!options.current() || busy || pending || retryable) return;
    const ticket = ++serial; busy = true; error = ''; publish();
    try {
      const next = settings(await options.request('/api/config/settings'));
      if (options.current() && ticket === serial) { preferences = next; loaded = true; }
    } catch (failure) { if (options.current() && ticket === serial) error = String(failure instanceof Error ? failure.message : failure); }
    finally { if (ticket === serial) { busy = false; publish(); } }
  }
  async function persist(action: 'favorite' | 'recent', value: ModelRef, close: boolean) {
    if (!options.current() || busy || pending || retryable || !loaded) return;
    retryable = () => persist(action, value, close);
    busy = true; error = ''; publish();
    try {
      const latest = settings(await options.request('/api/config/settings'));
      if (!options.current()) return;
      const patch = preferenceUpdate(latest, action, value);
      pending = { patch, close };
      const response = record(await options.request('/api/config/settings', 'PUT', patch));
      if (!options.current()) return;
      if (response.ok === false || response.success === false || response.failed === true) throw new Error('model-preference-not-confirmed');
      preferences = { ...latest, ...patch }; pending = undefined; retryable = undefined;
      if (close) options.close();
    } catch (failure) {
      if (options.current()) {
        const status = record(failure).status;
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) pending = undefined;
        error = String(failure instanceof Error ? failure.message : failure);
      }
    } finally { busy = false; publish(); }
  }
  async function retry() {
    if (!options.current() || busy) return;
    if (!pending) { if (retryable) { const work = retryable; retryable = undefined; await work(); } else await load(); return; }
    busy = true; error = ''; publish();
    try {
      const latest = settings(await options.request('/api/config/settings'));
      if (!options.current()) return;
      if (!Object.entries(pending.patch).every(([key, value]) => JSON.stringify(latest[key]) === JSON.stringify(value))) throw new Error('model-preference-not-confirmed');
      const close = pending.close; preferences = latest; pending = undefined; retryable = undefined;
      if (close) options.close();
    } catch (failure) { if (options.current()) error = String(failure instanceof Error ? failure.message : failure); }
    finally { busy = false; publish(); }
  }
  return { load, retry, preferences: () => preferences, loaded: () => loaded, busy: () => busy, pending: () => !!pending || !!retryable, error: () => error,
    favorite: (value: ModelRef) => persist('favorite', value, false),
    choose: async (value: ModelRef) => {
      if (!options.current() || busy || pending || retryable || !loaded) return;
      options.select(value); await persist('recent', value, true);
    },
    clear() { if (options.current() && !busy && !pending && !retryable) { options.select({ providerID: '', modelID: '', variant: '' }); options.close(); } },
  };
}
