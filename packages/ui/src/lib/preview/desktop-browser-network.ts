import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { openGuiNetworkChannel } from '@/lib/gui-network/channel';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { hostApiPath } from '@/lib/remote-projects/location';
import { captureProjectScope } from '@/lib/api/project-scope';
import { subscribeRuntimeAuthGeneration } from '@/lib/runtime-auth';

type BrowserRelayBridge = {
  start(): Promise<{ scope: string; partition: string }>;
  write(scope: string, data: string | Uint8Array): Promise<void>;
  stop(scope: string): Promise<void>;
  subscribe(handler: (event: { scope: string; data: string | Uint8Array }) => void): () => void;
};

const bridge = (): BrowserRelayBridge | undefined => {
  if (typeof window === 'undefined') return;
  return (window as unknown as { __YURI_DESKTOP__?: { browserRelay?: BrowserRelayBridge } }).__YURI_DESKTOP__?.browserRelay;
};
/** Renderer owns runtime authentication/E2EE; main only sees opaque website bytes.
 * A lease belongs to one Browser tab and one runtime generation, never the app.
 */
export async function openDesktopBrowserNetwork(signal: AbortSignal, onFailure: (error: Error) => void, entry?: HostRuntimeEntry) {
  const api = bridge();
  if (!api) throw new Error('Browser network unsupported');
  const project = captureProjectScope(entry);
  const generation = getRuntimeGeneration();
  let ended = false;
  let lease: { scope: string; partition: string } | undefined;
  let channel: Awaited<ReturnType<typeof openGuiNetworkChannel>> | undefined;
  const controller = new AbortController();
  let unsubscribe = () => {};
  let unsubscribeRuntime = () => {};
  let unsubscribeAuth = () => {};
  let rejectPending: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
  // Cancellation can happen while setup is between awaited steps.
  void cancellation.catch(() => {});
  const release = () => {
    if (ended) return;
    ended = true;
    signal.removeEventListener('abort', abort);
    controller.abort();
    unsubscribe(); unsubscribeRuntime(); unsubscribeAuth();
    channel?.close();
    if (lease) void api.stop(lease.scope).catch(() => {});
    rejectPending(new DOMException('Browser runtime ended', 'AbortError'));
  };
  const fail = (error: Error) => {
    if (ended) return;
    release();
    onFailure(error);
  };
  const abort = () => release();
  const assertCurrent = () => {
    if (ended || signal.aborted || generation !== getRuntimeGeneration()) throw new DOMException('Browser runtime ended', 'AbortError');
    project.assertCurrent(signal);
  };
  const timeout = setTimeout(() => fail(new Error('Browser Relay timed out')), 20_000);
  try {
    assertCurrent();
    signal.addEventListener('abort', abort, { once: true });
    unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => fail(new Error('Browser runtime changed')));
    unsubscribeAuth = subscribeRuntimeAuthGeneration(() => fail(new Error('Browser authorization changed')));
    let receiveChain = Promise.resolve();
    let queued = 0;
    channel = await Promise.race([openGuiNetworkChannel({
      signal: controller.signal,
      path: hostApiPath(entry?.location.hostId, '/api/gui-network/ws'),
      openSocket(url) { assertCurrent(); return openRuntimeWebSocket(url); },
      onFailure: () => fail(new Error('Browser Relay disconnected')),
      onMessage(event) {
        if (ended || !lease) return;
        assertCurrent();
        const data = typeof event.data === 'string' ? event.data : new Uint8Array(event.data);
        const size = typeof data === 'string' ? data.length * 2 : data.byteLength;
        queued += size;
        if (queued > 4 * 1024 * 1024) { fail(new Error('Browser Relay buffer limit')); return; }
        receiveChain = receiveChain.then(async () => {
          if (!ended && lease) { assertCurrent(); await api.write(lease.scope, data); }
        }).catch(() => fail(new Error('Browser Relay stream failed'))).finally(() => { queued -= size; });
      },
    }), cancellation]);
    assertCurrent();
    const wire = channel.socket;
    unsubscribe = api.subscribe(event => {
      if (ended || event.scope !== lease?.scope) return;
      try {
        assertCurrent();
        if (wire.readyState !== 1) throw new Error('Browser Relay disconnected');
        wire.send(event.data);
      } catch { fail(new Error('Browser Relay disconnected')); }
    });
    const pendingLease = api.start().then(value => {
      if (ended) void api.stop(value.scope).catch(() => {});
      return value;
    });
    lease = await Promise.race([pendingLease, cancellation]);
    assertCurrent();
    if (!lease.partition.startsWith('yuri-browser-relay-')) throw new Error('Invalid Browser partition');
    return { partition: lease.partition, release };
  } catch (error) { release(); throw error; }
  finally { clearTimeout(timeout); }
}
