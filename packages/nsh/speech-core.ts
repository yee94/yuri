import { sanitizeForTTS } from '../ui/src/lib/voice/summarize';
import { splitSpeechText } from '../ui/src/lib/voice/speech-segments';

export type SpeechSettings = { visible: boolean; provider: string; mode: string };
export type SpeechState = { status: 'unloaded' | 'loading-settings' | 'idle' | 'loading' | 'playing' | 'error'; messageID?: string; settings?: SpeechSettings; failed?: boolean };
export type SpeechPlaybackResult = 'completed' | 'cancelled' | 'unavailable' | 'failed';
export type SpeechOperationSource = 'manual' | 'auto-read' | 'lifecycle';
export type SpeechIntent = { kind: 'play' | 'stop' | 'invalidate' | 'dispose'; source: SpeechOperationSource };
type Checkpoint = { id: string; text: string; chunks: string[]; index: number };
const providers = ['browser', 'local', 'say', 'openai', 'openai-compatible', 'volcengine'];
export function speechSettings(value: unknown): SpeechSettings {
  const v = value as Partial<SpeechSettings> | null;
  if (!v || typeof v.visible !== 'boolean' || !providers.includes(v.provider!) || !['final', 'sanitized', 'raw', 'summarized'].includes(v.mode!)) throw new Error('Invalid speech settings');
  return { visible: v.visible, provider: v.provider!, mode: v.mode! };
}
/** One page owner, no per-row IO. A checkpoint resumes at the interrupted segment. */
export function createSpeechController(input: {
  owner: string;
  current: () => boolean;
  call: (name: string, data: Record<string, unknown>) => Promise<unknown>;
  changed: (state: SpeechState) => void;
  summarize?: (text: string) => Promise<string | null>;
}) {
  let state: SpeechState = { status: 'unloaded' }, disposed = false, generation = 0, revision = 0;
  let preparing: Promise<void> | undefined, checkpoint: Checkpoint | undefined;
  let preparation = 0;
  let awakeRevision = 0, awakeGeneration = 0, awakeRequested = false;
  const listeners = new Set<(intent: SpeechIntent) => void>();
  const notify = (kind: SpeechIntent['kind'], source: SpeechOperationSource) => listeners.forEach(listener => listener({ kind, source }));
  const current = () => !disposed && input.current();
  const set = (next: SpeechState) => { state = next; if (!disposed) input.changed(next); };
  const call = (name: string, extra: Record<string, unknown> = {}) => input.call(`speech.${name}`, { owner: input.owner, ...extra });
  async function prepare() {
    if (!current() || state.settings) return;
    if (preparing) return preparing;
    const ticket = ++preparation;
    set({ status: 'loading-settings' });
    preparing = (async () => {
      try {
        const settings = speechSettings(await call('prepare'));
        if (current() && ticket === preparation) set({ status: 'idle', settings });
      } catch {
        if (current() && ticket === preparation) set({ status: 'error', failed: true });
      } finally { if (ticket === preparation) preparing = undefined; }
    })();
    return preparing;
  }
  async function halt() {
    generation++;
    const next = ++revision;
    set({ ...state, status: state.settings ? 'idle' : 'unloaded', failed: false });
    try { await call('stop', { revision: next }); }
    catch (failure) { if (current() && next === revision) set({ ...state, status: 'error', failed: true }); throw failure; }
  }
  async function stop(source: SpeechOperationSource = 'manual') { notify('stop', source); await halt(); }
  /** Same page owner, independent of audio revisions; false means no screen assertion was acquired. */
  async function awake(enabled: boolean): Promise<boolean> {
    if (disposed) return false;
    const ticket = ++awakeGeneration;
    if (enabled) {
      if (!current()) throw new Error('Speech owner is inactive');
      await prepare();
      if (!current() || ticket !== awakeGeneration) return false;
      if (!state.settings) throw new Error('Speech settings are unavailable');
    } else if (!awakeRequested) return false;
    awakeRequested = enabled;
    const response = await call('awake', { revision: ++awakeRevision, enabled });
    if (disposed || ticket !== awakeGeneration) return false;
    const result = response as { supported?: unknown; enabled?: unknown } | null;
    if (!result || typeof result.supported !== 'boolean' || typeof result.enabled !== 'boolean'
        || (result.enabled && (!enabled || !result.supported)) || (enabled && result.supported && !result.enabled)) throw new Error('Invalid speech awake response');
    return result.enabled;
  }
  async function play(id: string, text: string, restart = false, source: SpeechOperationSource = 'manual'): Promise<SpeechPlaybackResult> {
    if (!current()) return 'cancelled';
    notify('play', source);
    const request = generation + 1;
    try { await halt(); } catch { if (current() && request === generation) { set({ ...state, status: 'error', messageID: id, failed: true }); return 'failed'; } return 'cancelled'; }
    if (!current() || request !== generation) return 'cancelled';
    await prepare();
    const settings = state.settings;
    if (!current() || request !== generation) return 'cancelled';
    if (!settings || (!settings.visible && source !== 'auto-read')) return state.failed ? 'failed' : 'unavailable';
    const valid = () => current() && request === generation;
    set({ settings, status: 'loading', messageID: id });
    try {
      if (restart || checkpoint?.id !== id || checkpoint.text !== text) {
        let source = text;
        if (settings.mode === 'summarized' && text.length >= 600) {
          // Same explicit fallback as Web: model failure uses the cleaned original.
          try { source = await input.summarize?.(text) || text; } catch { source = text; }
          if (!valid()) return 'cancelled';
        }
        checkpoint = { id, text, chunks: splitSpeechText(sanitizeForTTS(source, true)), index: 0 };
      }
      const progress = checkpoint!;
      while (valid() && progress.index < progress.chunks.length) {
        set({ settings, status: 'loading', messageID: id });
        await call('segment', { revision: ++revision, text: progress.chunks[progress.index], source: source === 'auto-read' ? 'auto-read' : 'manual' });
        if (!valid()) return 'cancelled';
        progress.index++;
      }
      if (valid()) { checkpoint = undefined; set({ settings, status: 'idle' }); return 'completed'; }
      return 'cancelled';
    } catch {
      if (valid()) { set({ settings, status: 'error', messageID: id, failed: true }); return 'failed'; }
      return 'cancelled';
    }
  }
  function event(name: string, payload: unknown) {
    const value = payload as { owner?: unknown; revision?: unknown } | null;
    if (!value || value.owner !== input.owner || disposed) return;
    if (name === 'speech.playing' && value.revision === revision && current()) set({ ...state, status: 'playing' });
    if (name === 'speech.invalidated') {
      notify('invalidate', 'lifecycle');
      awakeGeneration++; awakeRequested = false;
      generation++; preparation++; checkpoint = undefined; preparing = undefined;
      set({ status: 'unloaded' });
    }
  }
  return {
    state: () => state, prepare, play, stop, awake, event,
    subscribeIntent(listener: (intent: SpeechIntent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    canResume: (id: string, text: string) => checkpoint?.id === id && checkpoint.text === text && checkpoint.index < checkpoint.chunks.length,
    async dispose() { if (disposed) return; notify('dispose', 'lifecycle'); disposed = true; listeners.clear(); generation++; awakeGeneration++; awakeRequested = false; checkpoint = undefined; await call('release'); },
  };
}
