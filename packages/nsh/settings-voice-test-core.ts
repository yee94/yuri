import { parseSpeechSettings, type SpeechSettings } from '../ui/src/lib/voice/speechSettings';
import { speechSettings } from './speech-core';

export type VoiceTestKind = 'tts' | 'asr';
/** Returned only after the editor has saved AND successfully read back the Host. Never include a draft or secret. */
export type VoiceTestConfirmation = { settings: SpeechSettings; draftRevision: number };
export type VoiceTestError = 'save-failed' | 'changed' | 'not-configured' | 'playback-failed' | 'asr-failed' | 'cleanup-failed';
export type VoiceTestState = {
  tts: 'idle' | 'saving' | 'loading' | 'playing' | 'stopping' | 'failed';
  ttsError: VoiceTestError | null;
  asr: 'closed' | 'saving' | 'idle' | 'starting' | 'recording' | 'processing' | 'finished' | 'failed' | 'unsupported';
  asrOpen: boolean; asrRevision: number; asrError: VoiceTestError | null; asrProvider: SpeechSettings['sttProvider'] | null;
  partial: string; transcript: string;
};
/** Native capture must use the current Host's configured STT, not NSH's system recognizer. */
export type VoiceTestAsrSession = {
  provider: SpeechSettings['sttProvider'];
  /** After a retryable failure, retry the same captured audio/provider, never begin a new recording implicitly. */
  finish: () => Promise<{ text: string }>;
  /** Must release capture/socket/replay audio even after a failed finish. */
  cancel: () => Promise<void>;
};
export type VoiceTestAsrAdapter = {
  supports: (provider: SpeechSettings['sttProvider']) => boolean;
  /** Cancels an in-flight start before a session exists. Must be idempotent and scoped to this owner/revision. */
  cancelStart: (input: { owner: string; revision: number }) => Promise<void>;
  /** `provider` is an expected identity check, NOT a provider override or credential. */
  start: (input: { owner: string; revision: number; provider: SpeechSettings['sttProvider']; partial: (text: string) => void }) => Promise<VoiceTestAsrSession>;
};
type Audio = { owner: string; revision: number; preparing: Promise<unknown> | null };
type Starting = { revision: number; promise: Promise<VoiceTestAsrSession>; cancelling?: Promise<boolean> };
const initial = (): VoiceTestState => ({ tts: 'idle', ttsError: null, asr: 'closed', asrOpen: false, asrRevision: 0, asrError: null, asrProvider: null, partial: '', transcript: '' });

/** Settings-only lifecycle. All audio still goes through the existing single Swift SpeechPlaybackBridge. */
export function createSettingsVoiceTestController(input: {
  owner: string; current: () => boolean; dirty: () => boolean; draftRevision: () => number;
  disabled: () => boolean; allowed: (kind: VoiceTestKind) => boolean;
  confirm: (kind: VoiceTestKind) => Promise<VoiceTestConfirmation | null>;
  call: (name: string, data: Record<string, unknown>) => Promise<unknown>;
  asr: VoiceTestAsrAdapter | null;
  previewText: (settings: SpeechSettings) => string;
  changed: (state: VoiceTestState) => void;
}) {
  let state = initial(), active = false, disposed = false, generation = 0, sequence = 0, dialogSequence = 0;
  let audio: Audio | null = null, session: VoiceTestAsrSession | null = null;
  let starting: Starting | null = null, finalResult: string | null = null;
  const retiredAudio = new Set<Audio>(), retiredSessions = new Set<VoiceTestAsrSession>(), retiredStarts = new Set<Starting>();
  let receipt: VoiceTestConfirmation | null = null;
  let cleanup: Promise<boolean> = Promise.resolve(true);
  const current = () => !disposed && active && input.current();
  const set = (change: Partial<VoiceTestState>) => { state = { ...state, ...change }; if (!disposed) input.changed(state); };
  const confirmed = (value: VoiceTestConfirmation) => !input.dirty() && value.draftRevision === input.draftRevision();
  const valid = (turn: number, value?: VoiceTestConfirmation) => turn === generation && current() && (!value || confirmed(value));
  const blocked = (kind: VoiceTestKind) => !current() || input.disabled() || !input.allowed(kind);
  const audioCall = (handle: Audio, name: string, extra: Record<string, unknown> = {}) => input.call(`speech.${name}`, { owner: handle.owner, ...extra });
  async function releaseAudio(handle: Audio) {
    let ok = true;
    const preparing = handle.preparing;
    try { await audioCall(handle, 'stop', { revision: ++handle.revision }); } catch { ok = false; }
    try { await audioCall(handle, 'release'); } catch { ok = false; }
    // Existing Swift releases only acquired owners. Retire a late prepare as well;
    // never allow an old prepare completion to become an orphaned page lease.
    if (preparing) {
      try { await preparing; } catch { /* A rejected prepare acquired no new lease. */ }
      try { await audioCall(handle, 'release'); } catch { ok = false; }
    }
    return ok;
  }
  function retire() {
    if (audio) retiredAudio.add(audio);
    if (session) retiredSessions.add(session);
    if (starting) retiredStarts.add(starting);
    audio = null; session = null; starting = null; receipt = null; finalResult = null;
    for (const pending of retiredStarts) if (!pending.cancelling) pending.cancelling = (async () => {
      let ok = true;
      try { await input.asr!.cancelStart({ owner: input.owner, revision: pending.revision }); } catch { ok = false; }
      let acquired: VoiceTestAsrSession | null = null;
      try { acquired = await pending.promise; } catch { /* A failed start acquired no session. */ }
      if (acquired) {
        try { await acquired.cancel(); } catch { ok = false; retiredSessions.add(acquired); }
      }
      return ok;
    })();
    cleanup = cleanup.then(async () => {
      const results = await Promise.allSettled([
        ...[...retiredAudio].map(async handle => { const ok = await releaseAudio(handle); if (ok) retiredAudio.delete(handle); return ok; }),
        ...[...retiredSessions].map(async handle => { await handle.cancel(); retiredSessions.delete(handle); return true; }),
        ...[...retiredStarts].map(async handle => { const ok = await handle.cancelling; if (ok) retiredStarts.delete(handle); else handle.cancelling = undefined; return ok; }),
      ]);
      return results.every(result => result.status === 'fulfilled' && result.value);
    });
    return cleanup;
  }
  async function authorize(kind: VoiceTestKind, turn: number): Promise<VoiceTestConfirmation | null> {
    let result: VoiceTestConfirmation | null;
    try {
      const value = await input.confirm(kind);
      result = value ? { settings: parseSpeechSettings(value.settings), draftRevision: value.draftRevision } : null;
    } catch { result = null; }
    if (!valid(turn)) return null;
    const error = !result ? 'save-failed' : !confirmed(result) ? 'changed'
      : (kind === 'tts' ? result.settings.voiceProvider : result.settings.sttProvider) === 'volcengine' && !result.settings.configured ? 'not-configured'
      : kind === 'tts' && result.settings.voiceProvider === 'openai-compatible' && !result.settings.openaiCompatibleUrl.trim() ? 'not-configured' : null;
    if (error) {
      set(kind === 'tts' ? { tts: 'failed', ttsError: error } : { asr: 'failed', asrError: error });
      return null;
    }
    receipt = result;
    return result;
  }
  async function stopPreview() {
    if (!audio && !['saving', 'loading', 'playing', 'stopping'].includes(state.tts)) return;
    const turn = ++generation;
    set({ tts: 'stopping', ttsError: null });
    const ok = await retire();
    if (turn === generation && !disposed) set({ tts: ok ? 'idle' : 'failed', ttsError: ok ? null : 'cleanup-failed' });
  }
  async function preview() {
    if (['saving', 'loading', 'playing', 'stopping'].includes(state.tts)) { await stopPreview(); return; }
    if (blocked('tts')) return;
    const turn = ++generation;
    set({ asrOpen: false, asr: 'closed', partial: '', transcript: '' });
    const clean = await retire();
    if (!valid(turn)) return;
    if (!clean) { set({ tts: 'failed', ttsError: 'cleanup-failed', asrError: 'cleanup-failed' }); return; }
    set({ tts: 'saving', ttsError: null, asr: 'closed', asrOpen: false, asrError: null, partial: '', transcript: '' });
    const value = await authorize('tts', turn);
    if (!value || !valid(turn, value)) return;
    const handle: Audio = { owner: `${input.owner}-${++sequence}`, revision: 0, preparing: null };
    audio = handle;
    set({ tts: 'loading' });
    try {
      handle.preparing = audioCall(handle, 'prepare');
      const prepared = speechSettings(await handle.preparing); handle.preparing = null;
      if (!valid(turn, value)) { if (audio === handle) { audio = null; await releaseAudio(handle); } return; }
      if (prepared.provider !== value.settings.voiceProvider) throw new Error('voice-test-provider-changed');
      const text = input.previewText(value.settings);
      let bytes = 0;
      for (const char of text) { const point = char.codePointAt(0)!; bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; }
      if (!text.trim() || bytes > 4096) throw new Error('voice-test-text-invalid');
      await audioCall(handle, 'segment', { revision: ++handle.revision, text, source: 'settings-preview' });
      if (valid(turn, value)) set({ tts: 'idle' });
    } catch {
      if (valid(turn)) set({ tts: 'failed', ttsError: 'playback-failed' });
    } finally {
      if (audio === handle) {
        audio = null;
        const ok = await releaseAudio(handle);
        if (!ok) retiredAudio.add(handle);
        if (!ok && valid(turn)) set({ tts: 'failed', ttsError: 'cleanup-failed' });
      }
    }
  }
  async function closeAsr(expectedRevision?: number) {
    if (expectedRevision !== undefined && expectedRevision !== state.asrRevision) return;
    if (!state.asrOpen && state.asr !== 'saving') return;
    const turn = ++generation;
    set({ asrOpen: false, asr: 'closed', asrError: null, partial: '', transcript: '', asrProvider: null });
    const ok = await retire();
    if (!ok && turn === generation && !disposed) set({ asrError: 'cleanup-failed' });
  }
  async function openAsr() {
    if (blocked('asr')) return;
    const turn = ++generation;
    set({ asrRevision: ++dialogSequence, asrOpen: false });
    const clean = await retire();
    if (!valid(turn)) return;
    if (!clean) { set({ asr: 'failed', asrError: 'cleanup-failed' }); return; }
    set({ tts: 'idle', ttsError: null, asr: 'saving', asrOpen: false, asrError: null, partial: '', transcript: '' });
    const value = await authorize('asr', turn);
    if (!value || !valid(turn, value)) return;
    const provider = value.settings.sttProvider;
    set({ asrOpen: true, asrProvider: provider, asr: input.asr?.supports(provider) ? 'idle' : 'unsupported' });
  }
  async function startAsr() {
    if (blocked('asr') || !state.asrOpen || ['saving', 'starting', 'recording', 'processing', 'unsupported'].includes(state.asr)) return;
    const turn = ++generation;
    const clean = await retire();
    if (!valid(turn)) return;
    if (!clean) { set({ asr: 'failed', asrError: 'cleanup-failed' }); return; }
    set({ asr: 'saving', asrError: null, partial: '', transcript: '' });
    const value = await authorize('asr', turn);
    if (!value || !valid(turn, value)) return;
    const provider = value.settings.sttProvider, adapter = input.asr;
    if (!adapter?.supports(provider)) { set({ asr: 'unsupported' }); return; }
    set({ asr: 'starting', asrProvider: provider });
    let acquisition: Starting | null = null;
    try {
      const revision = ++sequence;
      acquisition = { revision, promise: adapter.start({ owner: input.owner, revision, provider,
        partial: text => { if (valid(turn, value) && ['starting', 'recording', 'processing'].includes(state.asr) && typeof text === 'string') set({ partial: text }); } }) };
      starting = acquisition;
      const acquired = await acquisition.promise;
      if (!valid(turn, value)) { if (acquisition.cancelling) await acquisition.cancelling; else await acquired.cancel(); return; }
      if (acquired.provider !== provider) {
        retiredSessions.add(acquired); await acquired.cancel(); retiredSessions.delete(acquired);
        throw new Error('voice-test-provider-changed');
      }
      session = acquired; set({ asr: 'recording' });
    } catch {
      if (valid(turn)) set({ asr: 'failed', asrError: 'asr-failed' });
    } finally { if (starting === acquisition) starting = null; }
  }
  async function finishAsr() {
    if (blocked('asr') || !session || !receipt || !['recording', 'failed'].includes(state.asr)) return;
    if (!confirmed(receipt)) { await closeAsr(); set({ asrError: 'changed' }); return; }
    const turn = generation, captured = session, value = receipt;
    set({ asr: 'processing', asrError: null });
    try {
      const result = finalResult === null ? await captured.finish() : { text: finalResult };
      if (!valid(turn, value) || session !== captured) return;
      if (!result || typeof result.text !== 'string') throw new Error('voice-test-invalid-transcript');
      finalResult = result.text;
      await captured.cancel();
      if (!valid(turn, value) || session !== captured) return;
      session = null; finalResult = null;
      set({ asr: 'finished', transcript: result.text, partial: '' });
    } catch {
      if (valid(turn)) set({ asr: 'failed', asrError: finalResult === null ? 'asr-failed' : 'cleanup-failed' });
    }
  }
  function activate(value: boolean) {
    active = value;
    const stale = !!receipt && !confirmed(receipt);
    const hasWork = audio || session || starting || ['saving', 'loading', 'playing'].includes(state.tts) || state.asrOpen || state.asr === 'saving';
    if (hasWork && (!current() || stale || audio && !input.allowed('tts') || state.asrOpen && !input.allowed('asr'))) {
      const turn = ++generation;
      set({ ...initial(), ...(stale ? { ttsError: 'changed' as const, asrError: 'changed' as const } : {}) });
      void retire().then(ok => { if (!ok && turn === generation && !disposed) set({ tts: 'failed', ttsError: 'cleanup-failed' }); });
    }
  }
  return {
    snapshot: () => state, activate, preview, stopPreview, openAsr, closeAsr, startAsr, finishAsr,
    async retryAsr() { if (session) await finishAsr(); else await startAsr(); },
    event(name: string, payload: unknown) {
      const value = payload as { owner?: unknown; revision?: unknown } | null;
      if (!audio || !value || value.owner !== audio.owner || !current()) return;
      if (name === 'speech.playing' && value.revision === audio.revision && receipt && confirmed(receipt)) set({ tts: 'playing' });
      if (name === 'speech.invalidated') {
        const turn = ++generation;
        set({ tts: 'idle', ttsError: null });
        void retire().then(ok => { if (!ok && turn === generation && !disposed) set({ tts: 'failed', ttsError: 'cleanup-failed' }); });
      }
    },
    async dispose() { if (disposed) return; disposed = true; active = false; generation++; state = initial(); await retire(); },
  };
}
