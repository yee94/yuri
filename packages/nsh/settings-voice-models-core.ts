import { record, text } from './model';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { createSettingsLaneOwner, type SettingsRequestLane } from './settings-protocol';

export const voiceLocalModels: readonly { id: string; kind: 'stt' | 'tts'; label?: I18nKey; badge?: I18nKey; name?: string; sizeMB: number; accuracy?: number; speed?: number }[] = [
  { id: 'parakeet-tdt-0.6b-v2-int8', kind: 'stt', label: 'settings.voice.page.stt.model.parakeetV2', badge: 'settings.voice.page.stt.badge.bestForEnglish', sizeMB: 460, accuracy: 5, speed: 5 },
  { id: 'parakeet-tdt-0.6b-v3-int8', kind: 'stt', label: 'settings.voice.page.stt.model.parakeetV3', badge: 'settings.voice.page.stt.badge.bestForMultilingual', sizeMB: 465, accuracy: 5, speed: 4 },
  { id: 'whisper-base-int8', kind: 'stt', label: 'settings.voice.page.stt.model.whisperBase', sizeMB: 200, accuracy: 3, speed: 3 },
  { id: 'whisper-tiny-int8', kind: 'stt', label: 'settings.voice.page.stt.model.whisperTiny', sizeMB: 115, accuracy: 2, speed: 4 },
  { id: 'kokoro-en-v0_19', kind: 'tts', name: 'Kokoro', sizeMB: 305 },
];
export type VoiceModelStatus = { id: string; installed: boolean; downloading: boolean; downloadProgress: number | null; downloadError: string | null };
export function voiceModelSnapshot(value: unknown): VoiceModelStatus[] {
  const body = record(value);
  if (body.provider !== 'local' || !Array.isArray(body.models) || !Array.isArray(body.ttsModels) || body.ok === false || body.failed === true)
    throw new Error('voice-model-invalid-status');
  const seen = new Set<string>();
  return [...body.models, ...body.ttsModels].map(value => {
    const row = record(value);
    if (!text(row.id) || seen.has(text(row.id)) || typeof row.installed !== 'boolean' || typeof row.downloading !== 'boolean' ||
      row.downloadProgress !== null && (typeof row.downloadProgress !== 'number' || !Number.isFinite(row.downloadProgress) || row.downloadProgress < 0 || row.downloadProgress > 100) ||
      row.downloadError !== null && typeof row.downloadError !== 'string') throw new Error('voice-model-invalid-state');
    seen.add(text(row.id));
    return { id: text(row.id), installed: row.installed, downloading: row.downloading,
      downloadProgress: row.downloadProgress as number | null, downloadError: row.downloadError as string | null };
  });
}

/** Host owns downloads, including while this page is hidden. No optimistic install. */
export function createVoiceModelManager(options: {
  send: (path: string, method?: string) => Promise<unknown>; current: () => boolean; changed: () => void;
  schedule?: (work: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const transport = createSettingsLaneOwner(options.send, options.current);
  const receipts = new Map<string, { method: 'POST' | 'DELETE'; acknowledged: boolean }>();
  let models: VoiceModelStatus[] = [], error = '', loading = false, active = false, alive = true, generation = 0;
  let pending: string | null = null, operationError: { id: string; message: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | undefined;
  const schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout;
  const valid = (ticket: number, lane: SettingsRequestLane) => alive && active && lane.current() && ticket === generation;
  const notify = () => { if (alive && transport.capture()?.current()) options.changed(); };
  function stopTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function poll() {
    stopTimer();
    if (!alive || !active || !transport.capture()?.current() || error || !models.some(model => model.downloading)) return;
    const lane = transport.capture(), ticket = generation;
    timer = schedule(() => { if (!lane || !valid(ticket, lane)) return; timer = undefined; void refresh(); }, 2000);
  }
  async function refresh(): Promise<void> {
    const lane = transport.capture();
    if (!alive || !active || !lane?.current()) return;
    if (reading) return reading;
    const ticket = generation;
    loading = true; error = ''; stopTimer(); notify();
    const flight = (async () => {
      try {
        const next = voiceModelSnapshot(await lane.request('/api/dictation/status?provider=local'));
        if (valid(ticket, lane)) {
          models = next;
          for (const [id, receipt] of receipts) {
            const status = next.find(model => model.id === id);
            if (status && (receipt.method === 'POST' ? status.installed || status.downloading || !!status.downloadError : !status.installed && !status.downloading)) receipts.delete(id);
          }
        }
      } catch (cause) { if (valid(ticket, lane)) error = cause instanceof Error ? cause.message : String(cause); }
      finally { if (valid(ticket, lane)) { loading = false; notify(); poll(); } }
    })();
    reading = flight;
    try { await flight; } finally { if (reading === flight) reading = undefined; }
  }
  async function mutate(id: string, method: 'POST' | 'DELETE') {
    const lane = transport.capture();
    if (!alive || !active || !lane?.current() || pending || loading || error || !voiceLocalModels.some(model => model.id === id)) return;
    if (receipts.has(id)) { await refresh(); return; }
    const model = models.find(model => model.id === id);
    if (!model || model.downloading || method === 'DELETE' && !model.installed || method === 'POST' && model.installed) return;
    const ticket = generation;
    pending = id; operationError = null; stopTimer(); notify();
    const receipt = { method, acknowledged: false }; receipts.set(id, receipt);
    try {
      const path = `/api/dictation/models/${encodeURIComponent(id)}${method === 'POST' ? '/download' : ''}`;
      const result = record(await lane.request(path, method));
      if (!valid(ticket, lane)) return;
      if (result.ok !== true) { if (result.ok === false) receipts.delete(id); throw new Error(text(result.error) || 'voice-model-request-failed'); }
      receipt.acknowledged = true;
    } catch (cause) {
      if (valid(ticket, lane)) operationError = { id, message: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      if (valid(ticket, lane)) { pending = null; notify(); await refresh(); }
    }
  }
  function activate(value: boolean) {
    if (!alive || active === value) return;
    active = value; generation++; stopTimer(); reading = undefined; loading = false; pending = null;
    if (value) void refresh();
    notify();
  }
  function dispose() { alive = false; generation++; active = false; stopTimer(); }
  return { snapshot: () => ({ models, error, loading, pending, operationError }), refresh, mutate, activate, dispose,
    captureLane: transport.capture,
    replaceLane(next: SettingsRequestLane | null) { transport.replaceLane(next); generation++; active = false; stopTimer(); reading = undefined; loading = false; pending = null; notify(); },
  };
}
