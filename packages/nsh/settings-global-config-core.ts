import { createSettingsLaneOwner, settingsObject, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';

type ConfigFile = { target: 'opencode'; fileName: string; content: string };
export type GlobalConfigState = { file: ConfigFile | null; draft: string; busy: boolean; unconfirmed: boolean; error: 'load' | 'save' | null; saved: boolean };
function configFile(value: unknown): ConfigFile {
  const data = settingsObject(value);
  if (data.target !== 'opencode' || typeof data.fileName !== 'string' || !data.fileName || typeof data.content !== 'string') throw new Error('Invalid global config response');
  return { target: 'opencode', fileName: data.fileName, content: data.content };
}

/** Owns text, not parsed JSON: Host validates JSONC and owns file selection. */
export function createGlobalConfigEditor(request: SettingsRequest, current: () => boolean, changed: (state: GlobalConfigState) => void) {
  const transport = createSettingsLaneOwner(request, current);
  let state: GlobalConfigState = { file: null, draft: '', busy: false, unconfirmed: false, error: null, saved: false };
  let revision = 0, submitted: string | undefined;
  const set = (patch: Partial<GlobalConfigState>) => { state = { ...state, ...patch }; changed(state); };
  const path = '/api/config/global/opencode';
  const dirty = () => state.file !== null && state.draft !== state.file.content;
  async function load(discard = false) {
    const lane = transport.capture();
    if (!lane?.current() || state.busy) return;
    const turn = ++revision, valid = () => turn === revision && lane.current();
    set({ busy: true, error: null, saved: false });
    try {
      const file = configFile(await lane.request(path));
      if (!valid()) return;
      const preserve = state.file !== null && dirty() && !discard;
      const confirmed = submitted !== undefined && file.content === submitted;
      set({ file, draft: confirmed || !preserve ? file.content : state.draft, unconfirmed: false, saved: confirmed });
      submitted = undefined;
    } catch { if (valid()) set({ error: 'load' }); }
    finally { if (valid()) set({ busy: false }); }
  }
  return { state: () => state, dirty, load,
    edit(value: string) { if (transport.capture()?.current() && state.file && !state.busy && !state.unconfirmed) set({ draft: value, saved: false }); },
    replaceLane(lane: SettingsRequestLane | null) { revision++; transport.replaceLane(lane); set({ busy: false }); },
    async save() {
      const lane = transport.capture();
      if (!lane?.current() || !state.file || state.busy) return;
      // A failed/unknown receipt only authorizes a GET on the next action.
      if (state.unconfirmed) { await load(); return; }
      if (!dirty()) return;
      const turn = ++revision, valid = () => turn === revision && lane.current();
      submitted = state.draft;
      set({ busy: true, unconfirmed: true, error: null, saved: false });
      try {
        const file = configFile(await lane.request(path, 'PUT', { content: submitted }));
        if (!valid()) return;
        if (file.content !== submitted) throw new Error('Global config receipt mismatch');
        submitted = undefined;
        set({ file, draft: file.content, unconfirmed: false, saved: true });
      } catch { if (valid()) set({ error: 'save' }); }
      finally { if (valid()) set({ busy: false }); }
    },
  };
}
