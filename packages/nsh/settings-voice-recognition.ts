import type { VoiceTestAsrAdapter, VoiceTestAsrSession } from './settings-voice-test-core';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

type Provider = VoiceTestAsrSession['provider'];
type Input = {
  expectedHost: RuntimeScope | null;
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  on: (name: string, callback: (value: unknown) => void) => () => void;
  /** Actual page/Host-generation fence, not provider configuration or draft state. */
  current: () => boolean;
  /** Controller owner should close the tester when native cancels on interruption/limit. */
  invalidated?: () => void;
};
type Capture = { owner: string; revision: number; provider: Provider; partial: (text: string) => void; cancelled: boolean; invalidated: boolean; finishing: Promise<{ text: string }> | null };
const providers: readonly Provider[] = ['local', 'openai-compatible', 'volcengine'];
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Explicit capability discovery: do not install this adapter from an optimistic
 * provider guess. The controller still owns save + authoritative readback and its
 * draftRevision fence. Only expected provider / owner / monotonic revision and
 * the owner's captured opaque Host scope cross JS. */
export async function createSettingsVoiceRecognitionAdapter(input: Input): Promise<VoiceTestAsrAdapter & { dispose: () => Promise<void> }> {
  const expectedHost = runtimeScopeFrom(input.expectedHost);
  const capabilities = object(await input.call('voiceRecognition.capabilities', {}));
  const available = capabilities?.providers;
  if (!Array.isArray(available) || available.some(value => !providers.includes(value as Provider))
      || new Set(available).size !== available.length || capabilities?.maximumSeconds !== 60 || capabilities.maximumBytes !== 1_920_000) {
    throw new Error('voice-recognition-invalid-capabilities');
  }
  let disposed = false;
  let capture: Capture | null = null;
  const current = (value: Capture) => !disposed && capture === value && !value.cancelled && !value.invalidated && input.current();
  const cancel = async (value: Capture) => {
    value.cancelled = true;
    // Retry is allowed after transport/bridge cleanup failure. Do not clear the
    // captured lease until native has confirmed cleanup.
    await input.call('voiceRecognition.cancel', { owner: value.owner, revision: value.revision });
    if (capture === value) capture = null;
  };
  const subscriptions = ['voiceRecognition.partial', 'voiceRecognition.invalidated'].map(name => input.on(name, raw => {
    const value = object(raw), active = capture;
    if (!value || !active || value.owner !== active.owner || value.revision !== active.revision) return;
    if (name === 'voiceRecognition.invalidated') { active.invalidated = true; input.invalidated?.(); return; }
    if (current(active) && typeof value.text === 'string' && value.text.length <= 65536) active.partial(value.text);
  }));
  const adapter: VoiceTestAsrAdapter & { dispose: () => Promise<void> } = {
    supports: provider => !disposed && !!expectedHost && available.includes(provider),
    async cancelStart({ owner, revision }) {
      const active = capture;
      if (active?.owner === owner && active.revision === revision) await cancel(active);
    },
    async start({ owner, revision, provider, partial }) {
      if (!expectedHost) throw new Error('scope_required');
      if (disposed || !input.current() || !adapter.supports(provider) || capture || !owner || owner.length > 128 || !Number.isSafeInteger(revision) || revision <= 0) {
        throw new Error('voice-recognition-invalid-start');
      }
      const active: Capture = { owner, revision, provider, partial, cancelled: false, invalidated: false, finishing: null };
      capture = active;
      let result: Record<string, unknown> | null;
      try {
        result = object(await input.call('voiceRecognition.start', { owner, revision, provider, expectedHost }));
        if (!current(active) || result?.provider !== provider || result.owner !== owner || result.revision !== revision) throw new Error('voice-recognition-stale-start');
      } catch (error) {
        await cancel(active);
        throw error;
      }
      return {
        provider,
        finish() {
          if (!current(active)) return Promise.reject(new Error('voice-recognition-stale-session'));
          if (active.finishing) return active.finishing;
          const pending = (async () => {
            const result = object(await input.call('voiceRecognition.finish', { owner, revision }));
            if (!current(active)) throw new Error('voice-recognition-stale-result');
            if (typeof result?.text !== 'string' || result.text.length > 65536) throw new Error('voice-recognition-invalid-transcript');
            return { text: result.text };
          })();
          active.finishing = pending;
          // A retry calls native finish on the same audio lease. No hidden capture.
          void pending.then(() => { if (active.finishing === pending) active.finishing = null; }, () => { if (active.finishing === pending) active.finishing = null; });
          return pending;
        },
        cancel: () => cancel(active),
      };
    },
    async dispose() {
      disposed = true;
      subscriptions.forEach(stop => stop());
      if (capture) await cancel(capture);
    },
  };
  return adapter;
}
