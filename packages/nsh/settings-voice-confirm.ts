import { parseSpeechSettings, speechSecretFields, type SpeechSettings } from '../ui/src/lib/voice/speechSettings';
import { settingsBasicFields } from './settings-basics-core';
import { settingsObject, type SettingsRequest } from './settings-protocol';
import type { VoiceTestConfirmation, VoiceTestKind } from './settings-voice-test-core';

type Draft = Record<string, unknown>;
type Pending = { patch: Draft; edits: Record<string, number>; revision: number; acknowledged: boolean };
type Lane = { send: SettingsRequest; current: () => boolean };
export type SettingsVoiceConfirmationState = { data: Draft; changes: Draft; draftRevision: number; ready: boolean };
const path = '/api/voice/settings';
const fields = settingsBasicFields('voice');
const configured = (key: string) => key === 'apiKey' ? 'configured' : `${key}Configured`;
// Public responses never supply editable credentials. Reject pasted mask/help text,
// too; an explicit empty string remains the deliberate clear-credential operation.
const placeholder = (value: string) => /^(?:[*•●·…]+|(?:sk-)?[*•●·…]+(?:.{0,4})?|<[^>]+>|\[[^\]]+\]|(?:your|enter|replace)[ _-].*(?:key|token).*)$/i.test(value.trim());

/** Production Voice editor owner: write once, then reconcile through a complete GET.
 * A public configured flag cannot prove an uncertain credential replacement. Such
 * an unknown write stays blocked instead of certifying or replaying the secret. */
export function createSettingsVoiceConfirmation(input: {
  send: SettingsRequest; current: () => boolean; active: () => boolean;
  changed: (state: SettingsVoiceConfirmationState) => void;
  invalidField?: (key: string) => string;
}) {
  let state: SettingsVoiceConfirmationState = { data: {}, changes: {}, draftRevision: 0, ready: false };
  let baseline: Draft = {};
  let edits: Record<string, number> = {}, pending: Pending | null = null, busy: object | null = null, disposed = false, readSequence = 0, active = false, generation = 0;
  let lane: Lane | null = { send: input.send, current: input.current };
  const current = (captured = lane) => !!captured && captured === lane && !disposed && active && captured.current() && input.active();
  const publish = () => input.changed(state);
  const fail = (code: string): never => { throw new Error(code); };
  const read = async (captured: Lane) => {
    const sequence = ++readSequence;
    const full = parseSpeechSettings(settingsObject(await captured.send(path)));
    if (!current(captured) || sequence !== readSequence) return null;
    return full;
  };
  const apply = (full: SpeechSettings, confirmed: Pending | null) => {
    const changes = { ...state.changes }, data: Draft = {};
    for (const field of fields) data[field.key] = speechSecretFields.has(field.key) ? '' : full[field.key as keyof SpeechSettings];
    baseline = { ...data };
    if (confirmed) for (const key of Object.keys(confirmed.patch)) {
      if (edits[key] === confirmed.edits[key]) delete changes[key];
    }
    // Newer input wins even if it happens to equal a previous submitted value.
    Object.assign(data, changes);
    state = { ...state, data, changes, ready: true }; publish();
  };
  function snapshotPatch(): Draft {
    const patch = { ...state.changes };
    for (const field of fields) if (field.key in patch) {
      if (field.kind === 'secret') {
        if (typeof patch[field.key] !== 'string' || placeholder(patch[field.key] as string)) fail('voice-secret-placeholder');
      } else if (field.kind === 'number') {
        const value = Number(patch[field.key]);
        if (patch[field.key] === '' || !Number.isFinite(value) || value < (field.min ?? 0) || value > (field.max ?? Infinity)) fail(input.invalidField?.(field.key) ?? 'voice-number-invalid');
        patch[field.key] = field.max ? Math.round(value) : value;
      }
    }
    return patch;
  }
  const matches = (full: SpeechSettings, transaction: Pending) => Object.entries(transaction.patch).every(([key, value]) => {
    if (speechSecretFields.has(key)) return transaction.acknowledged && full[configured(key) as keyof SpeechSettings] === !!String(value).trim();
    return full[key as keyof SpeechSettings] === (typeof value === 'string' ? value.trim() : value);
  });
  return {
    snapshot: () => state,
    pending: () => pending !== null,
    dirty: () => Object.entries(state.changes).some(([key, value]) => {
      if (speechSecretFields.has(key)) return true;
      const field = fields.find(field => field.key === key);
      const normalized = field?.kind === 'number' && value !== '' ? Number(value) : value;
      return !Object.is(normalized, baseline[key]);
    }),
    replaceLane(next: Lane | null) {
      if (disposed || lane === next) return;
      lane = next; generation++; readSequence++; busy = null;
    },
    activate(value: boolean) { if (active !== value) { active = value; generation++; readSequence++; } },
    update(key: string, value: unknown) {
      if (!current() || !fields.some(field => field.key === key)) return;
      const revision = state.draftRevision + 1; edits[key] = revision;
      state = { ...state, data: { ...state.data, [key]: value }, changes: { ...state.changes, [key]: value }, draftRevision: revision }; publish();
    },
    async load() {
      const captured = lane;
      if (!captured || !current(captured) || busy) return;
      const flight = {}; busy = flight;
      try { const full = await read(captured); if (full) apply(full, null); }
      finally { if (busy === flight) busy = null; }
    },
    async confirm(_kind: VoiceTestKind): Promise<VoiceTestConfirmation | null> {
      const captured = lane;
      if (!captured || !current(captured) || busy || !state.ready) return null;
      const flight = {}; busy = flight;
      const revision = state.draftRevision, turn = generation;
      try {
        if (!pending) {
          const patch = snapshotPatch();
          if (Object.keys(patch).length) {
            const transaction: Pending = { patch, edits: { ...edits }, revision, acknowledged: false };
            pending = transaction;
            let response: unknown;
            try { response = await captured.send(path, 'PUT', patch); }
            catch (error) {
              // This Host's 400 is an explicit validation rejection. Do not
              // generalize to every 4xx (e.g. a timeout may hide a commit).
              // Other failures retain the journal and only enter the GET lane.
              const status = (error as { status?: number } | null)?.status;
               if (status === 400 && current(captured) && pending === transaction) pending = null;
              throw error;
            }
            // The real Host PUT returns the full public settings object. Do not
            // treat {}, null, or a success-shaped placeholder as a save receipt.
            const acknowledged = parseSpeechSettings(settingsObject(response));
            transaction.acknowledged = true;
            if (!matches(acknowledged, transaction)) fail('voice-save-unconfirmed');
            if (!current(captured) || turn !== generation) return null;
          }
        }
        const transaction = pending;
        const full = await read(captured);
        if (!full || turn !== generation) return null;
        if (transaction && !matches(full, transaction)) fail('voice-save-unconfirmed');
        apply(full, transaction);
        pending = null;
        if (revision !== state.draftRevision || transaction && transaction.revision !== state.draftRevision || Object.keys(state.changes).length) return null;
        return { settings: full, draftRevision: state.draftRevision };
      } finally { if (busy === flight) busy = null; }
    },
    dispose() { disposed = true; readSequence++; pending = null; edits = {}; baseline = {}; state = { ...state, data: {}, changes: {} }; },
  };
}
