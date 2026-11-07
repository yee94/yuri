import { setupTourSteps, type SetupTourStep } from './setup-tour-core';

export type SetupTourProgress = { step: SetupTourStep; dismissed: boolean };
/** Ordinary device UI progress only: no credentials, operation leases or write
 * journals. Serialization prevents an older asynchronous save winning last. */
export function createSetupTourProgress(storage: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<unknown> }) {
  const key = 'yuri-nsh-setup-tour', entries = new Map<string, SetupTourProgress>();
  let loaded: Promise<void> | null = null, writes = Promise.resolve();
  const load = () => loaded ??= (async () => {
    const text = await storage.getItem(key);
    if (!text) return;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_tour_progress');
    for (const [host, raw] of Object.entries(value)) {
      if (!raw || typeof raw !== 'object' || !('step' in raw) || !('dismissed' in raw) || typeof raw.dismissed !== 'boolean' || !setupTourSteps.some(step => step === raw.step)) continue;
      const step = setupTourSteps.find(step => step === raw.step)!;
      entries.set(host, { step, dismissed: raw.dismissed });
    }
  })();
  return {
    async read(hostID: string) { await load(); return entries.get(hostID); },
    save(hostID: string, progress: SetupTourProgress) {
      const snapshot = { ...progress };
      const work = writes.catch(() => {}).then(async () => { await load(); entries.set(hostID, snapshot); await storage.setItem(key, JSON.stringify(Object.fromEntries(entries))); });
      writes = work; return work;
    },
  };
}
