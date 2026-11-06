import { getRuntimeGeneration } from '@/lib/runtime-switch';
import { openMobileGuiNetwork } from '@/lib/gui-plugins/mobile-network';

type Network = Awaited<ReturnType<typeof openMobileGuiNetwork>>;
type Owner = { failed(): void };
type SharedNetwork = {
  generation: number;
  controller: AbortController;
  owners: Set<Owner>;
  ready: Promise<Network>;
  failed: boolean;
  closing?: Promise<void>;
};
let active: SharedNetwork | undefined;
const cancelled = () => new DOMException('Mobile HTML owner ended', 'AbortError');

/** GUI hosts and built-in HTML views share the data-store/process scoped gateway. */
export async function acquireMobileHtmlNetwork(signal: AbortSignal, onFailure: () => void): Promise<Network> {
  if (signal.aborted) throw cancelled();
  const generation = getRuntimeGeneration();
  let shared = active;
  if (shared?.generation === generation && shared.failed && shared.owners.size) throw new Error('relay_unavailable');
  if (!shared || shared.generation !== generation || shared.closing) {
    const controller = new AbortController();
    const entry: SharedNetwork = {
      generation, controller, owners: new Set(), failed: false,
      ready: Promise.resolve().then(() => openMobileGuiNetwork(controller.signal, () => {
        if (entry.failed) return;
        entry.failed = true;
        for (const owner of Array.from(entry.owners)) owner.failed();
      })),
    };
    shared = active = entry;
  }
  const entry = shared;
  const owner: Owner = { failed: onFailure };
  entry.owners.add(owner);
  let released = false;
  let completion: Promise<void> | undefined;
  let rejectCancelled!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const release = (): Promise<void> => {
    if (completion) return completion;
    released = true;
    signal.removeEventListener('abort', aborted);
    entry.owners.delete(owner);
    if (entry.owners.size) return completion = Promise.resolve();
    if (active === entry) active = undefined;
    entry.controller.abort();
    entry.closing ??= entry.ready.then(network => network.release(), () => {});
    return completion = entry.closing;
  };
  const aborted = () => { rejectCancelled(cancelled()); void release().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    const network = await Promise.race([entry.ready, cancellation]);
    if (released || signal.aborted || generation !== getRuntimeGeneration()) throw cancelled();
    if (entry.failed) throw new Error('relay_unavailable');
    return { hostOrigin: network.hostOrigin, release };
  } catch (error) {
    await release();
    throw error;
  }
}
