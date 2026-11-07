import type { Message } from './model';
import type { SpeechIntent, SpeechOperationSource, SpeechPlaybackResult, SpeechState } from './speech-core';

const NATIVE_AUTO_READ_KEY = 'yuri.auto-read';
type PreferenceState = { preferred: boolean; ready: boolean; error: 'preference-read' | 'preference-write' | null };
/** One device preference, shared by mounted Chats; no audio ownership here. */
export function createNativeAutoReadPreference(storage: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> }) {
  let state: PreferenceState = { preferred: false, ready: false, error: null };
  let lane: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: PreferenceState) => { state = next; listeners.forEach(listener => listener()); };
  async function load() {
    try {
      const raw = await storage.getItem(NATIVE_AUTO_READ_KEY);
      publish({ preferred: raw === 'true', ready: true, error: null });
    } catch { publish({ ...state, ready: false, error: 'preference-read' }); }
  }
  const ready = load();
  lane = ready;
  return {
    state: () => state, ready,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retry() { lane = lane.then(load); return lane; },
    set(preferred: boolean) {
      const operation = lane.then(async () => {
        try {
          await storage.setItem(NATIVE_AUTO_READ_KEY, String(preferred));
          publish({ preferred, ready: true, error: null });
        } catch { publish({ ...state, error: 'preference-write' }); }
      });
      lane = operation;
      return operation;
    },
  };
}
export type NativeAutoReadPreference = ReturnType<typeof createNativeAutoReadPreference>;
export type NativeAutoReadSnapshot = {
  /** Include Host generation, directory, target kind/id and history reset generation. */
  scope: string; sessionID: string; active: boolean; foreground: boolean; resolved: boolean; recognizing: boolean;
  messages: readonly Pick<Message, 'id' | 'role' | 'time'>[];
};
export type NativeAutoReadReply = { scope: string; sessionID: string; messageID: string; created: number; text: string };
export type NativeAutoReadState = {
  preferred: boolean; available: boolean; running: boolean; playingMessageID: string | null;
  error: PreferenceState['error'] | 'playback' | null;
};
type Speech = {
  state: () => SpeechState;
  play: (id: string, text: string, restart?: boolean, source?: SpeechOperationSource) => Promise<SpeechPlaybackResult>;
  stop: (source?: SpeechOperationSource) => Promise<void>;
  subscribeIntent: (listener: (intent: SpeechIntent) => void) => () => void;
};

/** Only committed body callbacks admit replies; transcript snapshots establish a floor, never enqueue. */
export function createNativeAutoReadController(input: { speech: Speech; preference: NativeAutoReadPreference; changed: (state: NativeAutoReadState) => void }) {
  let snapshot: NativeAutoReadSnapshot | undefined, running = false, disposed = false, floor = 0, generation = 0;
  let playingMessageID: string | null = null, error: NativeAutoReadState['error'] = null;
  let seen = new Set<string>(), observed = new Set<string>();
  let pending: NativeAutoReadReply[] = [];
  let recognitionGuard = false, halted = false;
  let toggleLane = Promise.resolve();
  const available = () => !!snapshot?.active && snapshot.resolved && !!snapshot.sessionID;
  const state = (): NativeAutoReadState => ({ preferred: input.preference.state().preferred, available: available(), running, playingMessageID, error: input.preference.state().error ?? error });
  const publish = () => { if (!disposed) input.changed(state()); };
  function arm() {
    if (halted || recognitionGuard || !snapshot || !available() || !snapshot.foreground || snapshot.recognizing || !input.preference.state().ready || !input.preference.state().preferred || input.preference.state().error) return;
    floor = 0; seen = new Set(); observed = new Set();
    for (const message of snapshot.messages) {
      floor = Math.max(floor, message.time?.created ?? 0);
      if (message.role !== 'assistant' || message.time?.completed != null) seen.add(message.id);
    }
    generation++; running = true;
  }
  async function cancel() {
    generation++; running = false; pending = []; playingMessageID = null;
    publish();
    const ticket = generation;
    try { await input.speech.stop('auto-read'); return true; } catch { if (!disposed && ticket === generation) { halted = true; error = 'playback'; publish(); } return false; }
  }
  async function drain() {
    if (!running || playingMessageID || !snapshot?.foreground || snapshot.recognizing) return;
    const reply = pending.shift(); if (!reply) return;
    const ticket = generation;
    playingMessageID = reply.messageID; publish();
    let result: SpeechPlaybackResult;
    try { result = await input.speech.play(reply.messageID, reply.text, true, 'auto-read'); }
    catch { result = 'failed'; }
    if (disposed || ticket !== generation) return;
    playingMessageID = null;
    if (result !== 'completed') {
      running = false; halted = true; pending = [];
      if (result === 'failed' || result === 'unavailable') error = 'playback';
      publish(); return;
    }
    publish();
    void drain();
  }
  let lastPreferred = input.preference.state().preferred;
  const unsubscribe = input.preference.subscribe(() => {
    const preferred = input.preference.state().preferred, changed = preferred !== lastPreferred;
    lastPreferred = preferred;
    if (!input.preference.state().preferred) { if (running || playingMessageID) void cancel(); else publish(); return; }
    if (changed) { halted = false; error = null; }
    if (!running) arm();
    publish();
  });
  const unsubscribeSpeech = input.speech.subscribeIntent(intent => {
    if (intent.source === 'auto-read') return;
    const automatic = !!playingMessageID || pending.length > 0;
    generation++; running = false; pending = []; playingMessageID = null;
    if (intent.source === 'manual' || intent.kind === 'dispose') halted = true;
    publish();
    // The user's active-message stop has the same persistent disable semantics as Web.
    if (intent.source === 'manual' && automatic) void input.preference.set(false);
  });
  return {
    state,
    update(next: NativeAutoReadSnapshot) {
      if (disposed) return;
      const reset = !snapshot || snapshot.scope !== next.scope || snapshot.active !== next.active || snapshot.resolved !== next.resolved || snapshot.foreground !== next.foreground || snapshot.recognizing !== next.recognizing;
      const newScope = !snapshot || snapshot.scope !== next.scope || snapshot.active !== next.active || snapshot.resolved !== next.resolved;
      snapshot = next;
      if (newScope) { halted = false; error = null; }
      if (reset) { if (running || playingMessageID) void cancel(); arm(); publish(); }
    },
    toggle() {
      toggleLane = toggleLane.then(async () => {
        if (disposed) return;
        if (input.preference.state().preferred) { await cancel(); if (!disposed) await input.preference.set(false); }
        else if (available() && input.preference.state().ready) await input.preference.set(true);
      });
      return toggleLane;
    },
    /** Call before Speech.available/start, not only after recording becomes true. */
    async beginRecognition() {
      if (disposed) throw new Error('Automatic speech owner is disposed');
      recognitionGuard = true;
      if (!await cancel()) throw new Error('Unable to stop speech before recognition');
    },
    endRecognition() { if (disposed || !recognitionGuard) return; recognitionGuard = false; arm(); publish(); },
    streaming(reply: Pick<NativeAutoReadReply, 'scope' | 'sessionID' | 'messageID'>) {
      if (!disposed && running && reply.messageID && reply.scope === snapshot?.scope && reply.sessionID === snapshot.sessionID) observed.add(reply.messageID);
    },
    rendered(reply: NativeAutoReadReply) {
      if (disposed || !running || !reply.messageID || reply.scope !== snapshot?.scope || reply.sessionID !== snapshot.sessionID || !reply.text.trim() || seen.has(reply.messageID) || (reply.created < floor && !observed.has(reply.messageID))) return;
      seen.add(reply.messageID); pending.push(reply); void drain();
    },
    async dispose() { if (disposed) return; disposed = true; unsubscribe(); unsubscribeSpeech(); await cancel(); seen.clear(); observed.clear(); snapshot = undefined; },
  };
}
