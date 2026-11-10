import { expect, it, vi } from 'vitest';
import { createMobileGuiWireFactory, type MobileGuiWireBridge } from './mobile-network-wire';

async function fixture() {
  let receive!: Parameters<MobileGuiWireBridge['addListener']>[1];
  const remove = vi.fn();
  const bridge: MobileGuiWireBridge = {
    connect: vi.fn(async () => {}), write: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    addListener: async (_event, callback) => { receive = callback; return { remove }; },
  };
  const factory = await createMobileGuiWireFactory(bridge, 'owner');
  const wire = factory.createWireSocket('wss://relay.example/ws');
  const { wireId } = vi.mocked(bridge.connect).mock.calls[0][0];
  const emit = (type: string, extra = {}) => receive({ scope: 'owner', wireId, type, ...extra });
  return { factory, bridge, wire, emit, remove };
}

it('preserves binary views, serializes native writes and isolates stale wire events', async () => {
  const { factory, bridge, wire, emit } = await fixture();
  wire.onopen = vi.fn(); wire.onmessage = vi.fn();
  emit('open', { scope: 'old' }); expect(wire.onopen).not.toHaveBeenCalled();
  emit('open'); expect(wire.onopen).toHaveBeenCalledOnce();
  let written!: () => void;
  vi.mocked(bridge.write).mockImplementationOnce(() => new Promise(resolve => { written = resolve; }));
  const input = new Uint8Array([0, 1, 255, 2]);
  wire.send(input.subarray(1, 3)); input.fill(9);
  wire.send('next');
  await vi.waitFor(() => expect(bridge.write).toHaveBeenCalledOnce());
  expect(vi.mocked(bridge.write).mock.calls[0][0].data).toBe(btoa(String.fromCharCode(1, 255)));
  written();
  await vi.waitFor(() => expect(bridge.write).toHaveBeenCalledTimes(2));
  emit('message', { data: btoa(String.fromCharCode(2, 0, 255)) });
  const event = vi.mocked(wire.onmessage).mock.calls[0][0];
  expect(new Uint8Array(event.data as ArrayBuffer)).toEqual(new Uint8Array([2, 0, 255]));
  await factory.dispose();
  emit('message', { text: 'late' }); expect(wire.onmessage).toHaveBeenCalledOnce();
  expect(wire.readyState).toBe(3);
});

it('fails a saturated native wire instead of accumulating unbounded ciphertext', async () => {
  const { factory, bridge, wire, emit } = await fixture();
  wire.onclose = vi.fn();
  emit('open');
  vi.mocked(bridge.write).mockImplementation(() => new Promise(() => {}));
  for (let i = 0; i < 5; i++) wire.send(new Uint8Array(1024 * 1024));
  expect(wire.readyState).toBe(3);
  expect(wire.onclose).toHaveBeenCalledWith({ code: 1006, reason: '' });
  expect(bridge.disconnect).toHaveBeenCalledOnce();
  await factory.dispose();
});

it('snapshots ArrayBuffer data at send time while an earlier native write is pending', async () => {
  const { factory, bridge, wire, emit } = await fixture();
  emit('open');
  let written!: () => void;
  vi.mocked(bridge.write).mockImplementationOnce(() => new Promise(resolve => { written = resolve; }));
  wire.send('first');
  await vi.waitFor(() => expect(written).toBeDefined());
  const bytes = new Uint8Array([1, 2, 3]);
  wire.send(bytes.buffer);
  bytes.fill(9);
  written();
  await vi.waitFor(() => expect(bridge.write).toHaveBeenCalledTimes(2));
  expect(vi.mocked(bridge.write).mock.calls[1][0].data).toBe('AQID');
  await factory.dispose();
});
