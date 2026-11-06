import type { PluginListenerHandle } from '@capacitor/core';
import type { TunnelWireSocket } from '@/lib/relay/tunnel-client';

type WireEvent = { scope: string; wireId: string; type: string; text?: string; data?: string; code?: number };
export type MobileGuiWireBridge = {
  connect(input: { scope: string; wireId: string; url: string }): Promise<void>;
  write(input: { scope: string; wireId: string; text?: string; data?: string }): Promise<void>;
  disconnect(input: { scope: string; wireId: string }): Promise<void>;
  addListener(event: 'wire', listener: (event: WireEvent) => void): Promise<PluginListenerHandle>;
};

const encode = (data: Uint8Array): string => {
  let raw = '';
  for (let offset = 0; offset < data.length; offset += 16384) raw += String.fromCharCode(...data.subarray(offset, offset + 16384));
  return btoa(raw);
};

/** Native transports only the paired Relay's opaque wire; E2EE stays in the existing client. */
export async function createMobileGuiWireFactory(bridge: MobileGuiWireBridge, scope: string) {
  const wires = new Map<string, { socket: TunnelWireSocket; receive(event: WireEvent): void }>();
  let ended = false;
  const listener = await bridge.addListener('wire', event => {
    if (!ended && event.scope === scope) wires.get(event.wireId)?.receive(event);
  });
  return {
    createWireSocket(url: string): TunnelWireSocket {
      if (ended) throw new Error('closed');
      const wireId = crypto.randomUUID();
      let state = 0;
      let pending = 0;
      let writes = Promise.resolve();
      const finish = (code: number) => {
        if (state === 3) return;
        state = 3; wires.delete(wireId);
        void bridge.disconnect({ scope, wireId }).catch(() => {});
        socket.onclose?.({ code, reason: '' });
      };
      const fail = () => { if (state !== 3) { socket.onerror?.(); finish(1006); } };
      const socket: TunnelWireSocket = {
        get readyState() { return state; },
        onopen: null, onmessage: null, onclose: null, onerror: null,
        send(data) {
          if (state !== 1) throw new Error('wire_closed');
          const text = typeof data === 'string' ? data : undefined;
          const bytes = text === undefined ? new Uint8Array(data instanceof ArrayBuffer ? data.slice(0) : data as Uint8Array) : undefined;
          const length = text === undefined ? bytes!.length : text.length * 2;
          if (length > 2 * 1024 * 1024 || pending + length > 4 * 1024 * 1024) { fail(); return; }
          pending += length;
          writes = writes.then(async () => {
            if (state !== 1) return;
            await bridge.write({ scope, wireId, text, data: bytes ? encode(bytes) : undefined });
          }).catch(fail).finally(() => { pending -= length; });
        },
        close() { finish(1000); },
      };
      wires.set(wireId, { socket, receive(event) {
        if (state === 3) return;
        if (event.type === 'open') { state = 1; socket.onopen?.(); }
        else if (event.type === 'close') finish(event.code ?? 1006);
        else if (event.type === 'message') {
          try {
            const data = event.text ?? Uint8Array.from(atob(event.data ?? ''), char => char.charCodeAt(0)).buffer;
            socket.onmessage?.({ data });
          } catch { fail(); }
        }
      } });
      void bridge.connect({ scope, wireId, url }).catch(fail);
      return socket;
    },
    async dispose() {
      ended = true;
      for (const { socket } of wires.values()) socket.close();
      wires.clear();
      await listener.remove();
    },
  };
}
