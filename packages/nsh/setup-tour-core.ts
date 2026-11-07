import { splitPluginSpec } from '../ui/src/components/sections/plugins/pluginPresentation';
import { parseSpeechSettings, type SpeechSettings } from '../ui/src/lib/voice/speechSettings';
import type { Row } from './model';
import { readSettingsCollection, scopedSettingsPath, settingsMutation, settingsObject, settingsRows, type SettingsRequest } from './settings-protocol';
import type { HistoryImportController } from './history-import-core';
import type { SetupTourLane } from './setup-tour-operation';

// Current Web has four steps: history import was added between tools and voice.
export const setupTourSteps = ['models', 'plugins', 'import', 'voice'] as const;
export type SetupTourStep = typeof setupTourSteps[number];
export const setupTourPlugins = ['opencode-magpie-plugin', '@eficy/opencode2-plugin', '@yee94/opencode-profile'] as const;
export const setupTourProviders = [
  { id: 'openai', name: 'OpenAI' }, { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google Gemini' }, { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'deepseek', name: 'DeepSeek' }, { id: 'openrouter', name: 'OpenRouter' },
] as const;
export type SetupTourMetadata = { spec: string; name: string; description?: string; icon?: string; readme?: string; latestVersion?: string | null };
export type SetupTourSnapshot = {
  step: SetupTourStep; provider: 'magpie' | 'other'; selected: readonly string[];
  entries: readonly Row[] | null; metadata: Readonly<Record<string, SetupTourMetadata>>;
  speech: SpeechSettings | null; busy: boolean; loading: boolean; error: 'tour.operationFailed' | 'tour.metadataUnavailable' | 'tour.noModels' | 'tour.saveFailed' | null;
  failedNames: readonly string[]; closed: boolean;
};
export function setupTourHasPlugin(entries: readonly Row[], spec: string): boolean {
  return entries.some(entry => !entry.file && entry.parsedKind === 'npm' && typeof entry.spec === 'string' && splitPluginSpec(entry.spec).name === spec);
}

/** One captured Host/generation owns this controller. Keep it alive while detail
 * pages cover the Tour: acknowledgement journals must survive navigation. No
 * configuration/progress store, install endpoint, timers or credentials live here. */
export function createSetupTour(input: {
  send: SettingsRequest; directory?: string; current: () => boolean;
  displayCurrent?: () => boolean;
  step?: SetupTourStep; onMove?: (step: SetupTourStep) => void; onClose?: () => void;
}) {
  let state: SetupTourSnapshot = { step: input.step ?? 'models', provider: 'magpie', selected: setupTourPlugins.slice(1), entries: null, metadata: {}, speech: null, busy: false, loading: false, error: null, failedNames: [], closed: false };
  const listeners = new Set<(value: SetupTourSnapshot) => void>();
  const journal = new Map<string, 'unknown' | 'acknowledged'>();
  let active = false, disposed = false, turn = 0, flight = false;
  let reading: { generation: number; promise: Promise<void> } | null = null;
  let lane: SetupTourLane = { send: input.send, current: input.current };
  const hostCurrent = () => !disposed && lane.current();
  const displayCurrent = () => !disposed && (input.displayCurrent?.() ?? lane.current());
  const current = (generation = turn) => hostCurrent() && active && !state.closed && generation === turn;
  const publish = (patch: Partial<SetupTourSnapshot>) => {
    state = { ...state, ...patch };
    if (hostCurrent()) for (const listener of listeners) listener(state);
  };
  const checked = async <T>(work: Promise<T>, generation: number): Promise<T> => {
    const result = await work;
    if (!current(generation)) throw new Error('setup-tour-retired');
    return result;
  };
  const entries = async (generation: number, captured: SetupTourLane) => {
    const rows = await checked(readSettingsCollection(captured.send, 'plugins', input.directory), generation);
    publish({ entries: rows }); return rows;
  };
  async function operation(work: (generation: number, captured: SetupTourLane) => Promise<void>, error: SetupTourSnapshot['error'] = 'tour.operationFailed') {
    if (!current() || flight) return;
    const generation = ++turn, captured = lane; flight = true; publish({ busy: true, loading: false, error: null, failedNames: [] });
    try { await work(generation, captured); }
    catch { if (current(generation) && !state.error) publish({ error }); }
    finally { if (captured === lane) { flight = false; if (hostCurrent()) publish({ busy: false }); } }
  }
  function move(step: SetupTourStep) {
    if (!current() || flight || step === state.step || !setupTourSteps.includes(step)) return;
    turn++; publish({ step, loading: false, error: null, failedNames: [] }); input.onMove?.(step);
  }
  function next() {
    const step = setupTourSteps[setupTourSteps.indexOf(state.step) + 1];
    turn++;
    if (step) { publish({ step, loading: false, error: null }); input.onMove?.(step); }
    else { publish({ closed: true, loading: false }); input.onClose?.(); }
  }
  async function savePlugins(specs: readonly string[], generation: number, captured: SetupTourLane): Promise<boolean> {
    const failed: string[] = [];
    for (const spec of new Set(specs)) {
      if (!current(generation)) return false;
      try {
        const before = await entries(generation, captured);
        if (setupTourHasPlugin(before, spec)) { journal.delete(spec); continue; }
        // An acknowledged/uncertain mutation can ONLY reconcile. An absent row
        // after ACK is not permission to reinstall or replay the config write.
        if (journal.has(spec)) { failed.push(spec); continue; }
        const mutation = settingsMutation('plugins', '', { spec, scope: 'user' }, true, input.directory);
        journal.set(spec, 'unknown');
        let result: unknown;
        try { result = await captured.send(mutation.path, mutation.method, mutation.body); }
        catch (error) {
          const status = (error as { status?: number } | null)?.status;
          if (captured === lane && typeof status === 'number' && status >= 400 && status < 500) journal.delete(spec);
          throw error;
        }
        // Remember ACK even if the page became covered while POST was in flight.
        if (captured !== lane || disposed) return false;
        try { if (settingsObject(result).success !== true) throw new Error('Plugin configuration not acknowledged'); }
        catch (error) { if (result && typeof result === 'object' && ((result as Row).ok === false || (result as Row).success === false)) journal.delete(spec); throw error; }
        journal.set(spec, 'acknowledged');
        if (!current(generation)) return false;
        const after = await entries(generation, captured);
        if (!setupTourHasPlugin(after, spec)) { failed.push(spec); continue; }
        journal.delete(spec);
      } catch { if (!current(generation)) return false; failed.push(spec); }
    }
    if (failed.length) { publish({ error: 'tour.saveFailed', failedNames: failed }); return false; }
    return true;
  }
  const controller = {
    current: hostCurrent,
    snapshot: () => state,
    subscribe(listener: (value: SetupTourSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate(value: boolean) { if (active !== value) { active = value; turn++; if (!value) publish({ loading: false }); } },
    move,
    selectProvider(value: 'magpie' | 'other') { if (current() && !flight) publish({ provider: value }); },
    togglePlugin(spec: string) {
      if (!current() || flight || !setupTourPlugins.slice(1).some(value => value === spec)) return;
      publish({ selected: state.selected.includes(spec) ? state.selected.filter(value => value !== spec) : [...state.selected, spec] });
    },
    refresh() {
      if (!current() || flight) return Promise.resolve();
      const generation = turn, step = state.step, captured = lane;
      if (reading?.generation === generation) return reading.promise;
      publish({ loading: true, error: null });
      const promise = (async () => {
        try {
          if (step === 'models' || step === 'plugins') await entries(generation, captured);
          if (step === 'plugins') {
            const path = scopedSettingsPath(`/api/config/plugins/registry?specs=${setupTourPlugins.slice(1).map(encodeURIComponent).join(',')}&details=true`, input.directory);
            const data = settingsObject(await checked(captured.send(path), generation));
            const metadata: Record<string, SetupTourMetadata> = {};
            for (const row of settingsRows(data.results)) {
              if (row.kind !== 'npm-ok' || typeof row.spec !== 'string' || !setupTourPlugins.slice(1).some(spec => spec === row.spec) || typeof row.name !== 'string') continue;
              for (const key of ['description', 'icon', 'readme', 'latestVersion']) if (row[key] != null && typeof row[key] !== 'string') throw new Error('Invalid plugin metadata');
              metadata[row.spec] = { spec: row.spec, name: row.name, description: row.description as string | undefined, icon: row.icon as string | undefined, readme: row.readme as string | undefined, latestVersion: row.latestVersion as string | null | undefined };
            }
            publish({ metadata: { ...state.metadata, ...metadata } });
            if (setupTourPlugins.slice(1).some(spec => !metadata[spec])) publish({ error: 'tour.metadataUnavailable' });
          }
          if (step === 'voice') publish({ speech: parseSpeechSettings(settingsObject(await checked(captured.send('/api/voice/settings'), generation))) });
        } catch { if (current(generation)) publish({ error: 'tour.operationFailed' }); }
        finally { if (current(generation)) publish({ loading: false }); if (reading?.generation === generation) reading = null; }
      })();
      reading = { generation, promise }; return promise;
    },
    async replaceLane(next: SetupTourLane): Promise<boolean> {
      if (disposed || !next.current()) return false;
      lane = { send: next.send, current: next.current }; turn++; flight = false; reading = null;
      publish({ busy: false, loading: false });
      await controller.refresh(); return hostCurrent();
    },
    proceed: () => operation(async (generation, captured) => {
      if (state.step === 'models') {
        if (state.provider === 'magpie') { if (!await savePlugins([setupTourPlugins[0]], generation, captured)) return; }
        else {
          const data = settingsObject(await checked(captured.send(scopedSettingsPath('/api/config/catalog/providers', input.directory)), generation));
          if (data.schemaVersion !== 1) throw new Error('Invalid provider catalog');
          const providers = settingsRows(data.providers);
          if (data.partial || !providers.some(provider => provider.models && typeof provider.models === 'object' && !Array.isArray(provider.models) && Object.keys(provider.models).length)) { publish({ error: 'tour.noModels' }); return; }
        }
      } else if (state.step === 'plugins') { if (!await savePlugins(state.selected, generation, captured)) return; }
      // Import has its own confirmed/background job owner; never silently skip it.
      else if (state.step === 'import') return;
      if (current(generation)) next();
    }),
    later() { if (current() && !flight) next(); },
    close() { if (current() && !flight) { turn++; publish({ closed: true, loading: false }); input.onClose?.(); } },
    dismissNavigation() { if (displayCurrent() && !flight && !state.closed) { turn++; publish({ closed: true, loading: false }); input.onClose?.(); } },
    reopen() { if (!displayCurrent() || flight) return false; turn++; publish({ closed: false, loading: false }); return true; },
    // Explicit detail-owner callbacks may navigate while the Tour is covered.
    // They never mutate a Host and still belong to this captured Host lifetime.
    completeImport() {
      if (!hostCurrent() || state.closed || flight || state.step !== 'import') return;
      turn++; publish({ step: 'voice', loading: false, error: null }); input.onMove?.('voice');
    },
    completeVoice() {
      if (!hostCurrent() || state.closed || flight || state.step !== 'voice') return;
      turn++; publish({ closed: true, loading: false }); input.onClose?.();
    },
    dispose() { disposed = true; turn++; listeners.clear(); journal.clear(); },
  };
  return controller;
}
export type SetupTourController = ReturnType<typeof createSetupTour> & { historyImport?: HistoryImportController };
