import { getRuntimeGeneration } from '@/lib/runtime-switch';
import { openMobileGuiNetwork, type MobileGuiNetwork } from '@/lib/gui-plugins/mobile-network';

type Owner = { failed(): void };
type SharedNetwork = {
  generation: number;
  controller: AbortController;
  owners: Set<Owner>;
  ready: Promise<MobileGuiNetwork>;
  closing?: Promise<void>;
};
export type MobileHtmlNetworkLease = Pick<MobileGuiNetwork, 'connect'> & { release(): Promise<void> };
let active: SharedNetwork | undefined;
const cancelled = () => new DOMException('Mobile HTML owner ended', 'AbortError');

/**
 * GUI hosts and built-in HTML views share the data-store/process scoped gateway.
 * Acquiring only routes plugin traffic; the Relay channel connects on first use
 * and channel loss notifies owners without ending the shared lease.
 */
export async function acquireMobileHtmlNetwork(signal: AbortSignal, onFailure: () => void): Promise<MobileHtmlNetworkLease> {
  if (signal.aborted) throw cancelled();
  const generation = getRuntimeGeneration();
  let shared = active;
  if (!shared || shared.generation !== generation || shared.closing) {
    const controller = new AbortController();
    const entry: SharedNetwork = {
      generation, controller, owners: new Set(),
      ready: Promise.resolve().then(() => openMobileGuiNetwork(controller.signal, () => {
        for (const owner of Array.from(entry.owners)) owner.failed();
      })),
    };
    // A failed open must not be shared by later owners.
    entry.ready.catch(() => { if (active === entry) active = undefined; });
    shared = active = entry;
  }
  const entry = shared;
  const owner: Owner = { failed: onFailure };
  entry.owners.add(owner);
  let completion: Promise<void> | undefined;
  let rejectCancelled!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const release = (): Promise<void> => {
    if (completion) return completion;
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
    if (completion || signal.aborted || generation !== getRuntimeGeneration()) throw cancelled();
    return { connect: owner => network.connect(owner ?? signal), release };
  } catch (error) {
    await release();
    throw error;
  }
}
