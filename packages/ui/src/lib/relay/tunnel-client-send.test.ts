// @vitest-environment node
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { wrapBrowserWebSocket } from './tunnel-client';

type SendData = string | ArrayBuffer | ArrayBufferView;
class RecordingWebSocket {
  static instances: RecordingWebSocket[] = [];
  readyState = 1;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  failure: Error | null = null;
  send = vi.fn((_data: SendData) => { if (this.failure) throw this.failure; });
  close = vi.fn();
  constructor(_url: string) { RecordingWebSocket.instances.push(this); }
}
beforeEach(() => { RecordingWebSocket.instances = []; vi.stubGlobal('WebSocket', RecordingWebSocket); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const open = () => {
  const socket = wrapBrowserWebSocket(new WebSocket('wss://socket.example'));
  return { socket, native: RecordingWebSocket.instances[0] };
};
const ordinaryCases: Array<[string, () => SendData]> = [
  ['string', () => 'text · 字节'],
  ['ArrayBuffer', () => new Uint8Array([1, 2, 3]).buffer],
  ['Uint8Array', () => new Uint8Array([1, 2, 3])],
  ['slice view', () => new Uint8Array([91, 1, 2, 3, 92]).subarray(1, 4)],
  ['Uint16Array offset', () => new Uint16Array(new Uint8Array([91, 92, 1, 2, 3, 4, 93, 94]).buffer, 2, 2)],
  ['DataView offset', () => new DataView(new Uint8Array([91, 1, 2, 3, 92]).buffer, 1, 3)],
  ['empty DataView', () => new DataView(new ArrayBuffer(8), 5, 0)],
];
const sharedCases: Array<[string, () => ArrayBufferView]> = [
  ['shared Uint8Array offset', () => { const buffer = new SharedArrayBuffer(8); new Uint8Array(buffer).set([91, 92, 1, 2, 3, 4, 93, 94]); return new Uint8Array(buffer, 2, 4); }],
  ['shared Uint16Array offset', () => { const buffer = new SharedArrayBuffer(8); new Uint8Array(buffer).set([91, 92, 1, 2, 3, 4, 93, 94]); return new Uint16Array(buffer, 2, 2); }],
  ['shared DataView offset', () => { const buffer = new SharedArrayBuffer(8); new Uint8Array(buffer).set([91, 92, 1, 2, 3, 4, 93, 94]); return new DataView(buffer, 2, 4); }],
  ['empty shared DataView', () => new DataView(new SharedArrayBuffer(8), 5, 0)],
];

describe('actual browser WebSocket adapter send boundary', () => {
  test.each(ordinaryCases)('preserves %s identity and exact view bounds without allocating a replacement', (_name, make) => {
    const { socket, native } = open(), input = make(); socket.send(input);
    expect(native.send).toHaveBeenCalledExactlyOnceWith(input);
    const sent = native.send.mock.calls[0][0]; expect(sent).toBe(input);
    if (ArrayBuffer.isView(input) && ArrayBuffer.isView(sent)) {
      expect(sent.buffer).toBe(input.buffer); expect(sent.byteOffset).toBe(input.byteOffset); expect(sent.byteLength).toBe(input.byteLength);
    }
  });
  test.each(sharedCases)('snapshots exactly the %s bytes to unshared storage', (_name, make) => {
    const { socket, native } = open(), input = make();
    const expected = Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    socket.send(input);
    const sent = native.send.mock.calls[0][0];
    expect(ArrayBuffer.isView(sent)).toBe(true);
    if (!ArrayBuffer.isView(sent)) throw new Error('Expected an unshared view');
    expect(sent).not.toBe(input); expect(sent.buffer).toBeInstanceOf(ArrayBuffer);
    expect(sent.buffer.byteLength).toBe(input.byteLength); expect(sent.byteOffset).toBe(0); expect(sent.byteLength).toBe(input.byteLength);
    new Uint8Array(input.buffer).fill(99);
    expect(Array.from(new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength))).toEqual(expected);
  });
  test.each([...ordinaryCases, ...sharedCases])('propagates the native send failure for %s without retrying', (_name, make) => {
    const { socket, native } = open(), failure = new Error('synthetic native send failed'); native.failure = failure;
    expect(() => socket.send(make())).toThrow(failure); expect(native.send).toHaveBeenCalledTimes(1);
  });
  test('recognizes foreign-realm unshared views without copying and foreign shared views without leaking adjacent bytes', () => {
    const foreign: { buffer: ArrayBuffer; view: Uint8Array; dataView: DataView; shared: DataView } = runInNewContext(`
      const buffer = new ArrayBuffer(8), shared = new SharedArrayBuffer(8);
      new Uint8Array(shared).set([91, 92, 1, 2, 3, 4, 93, 94]);
      ({ buffer, view: new Uint8Array(buffer, 2, 4), dataView: new DataView(buffer, 1, 5), shared: new DataView(shared, 2, 4) });
    `);
    expect(foreign.buffer instanceof ArrayBuffer).toBe(false);
    const { socket, native } = open();
    for (const input of [foreign.buffer, foreign.view, foreign.dataView]) { socket.send(input); expect(native.send.mock.lastCall?.[0]).toBe(input); }
    socket.send(foreign.shared);
    const sent = native.send.mock.lastCall?.[0];
    if (!ArrayBuffer.isView(sent)) throw new Error('Expected an unshared view');
    expect(sent.buffer).toBeInstanceOf(ArrayBuffer); expect(Array.from(new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength))).toEqual([1, 2, 3, 4]);
  });
  test('uses intrinsic buffer brands rather than spoofable toString tags', () => {
    const { socket, native } = open(), shared = new SharedArrayBuffer(6), normal = new ArrayBuffer(6);
    Object.defineProperty(shared, Symbol.toStringTag, { value: 'ArrayBuffer' });
    Object.defineProperty(normal, Symbol.toStringTag, { value: 'SharedArrayBuffer' });
    const view = new DataView(normal, 2, 3); socket.send(view); expect(native.send.mock.lastCall?.[0]).toBe(view);
    new Uint8Array(shared).set([91, 1, 2, 3, 4, 92]); socket.send(new DataView(shared, 1, 4));
    const sent = native.send.mock.lastCall?.[0];
    if (!ArrayBuffer.isView(sent)) throw new Error('Expected an unshared view');
    expect(sent.buffer).not.toBe(shared); expect(Array.from(new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength))).toEqual([1, 2, 3, 4]);
  });
  test('50 ordinary sends allocate no ArrayBuffer/Uint8Array and perform no byte copies in the adapter', () => {
    const { socket, native } = open();
    const inputs = ordinaryCases.map(([, make]) => make());
    const U8 = Uint8Array, AB = ArrayBuffer;
    let allocations = 0;
    const set = vi.spyOn(U8.prototype, 'set'), slice = vi.spyOn(U8.prototype, 'slice'), bufferSlice = vi.spyOn(AB.prototype, 'slice');
    vi.stubGlobal('Uint8Array', new Proxy(U8, { construct(target, args) { allocations++; return Reflect.construct(target, args); } }));
    vi.stubGlobal('ArrayBuffer', new Proxy(AB, { construct(target, args) { allocations++; return Reflect.construct(target, args); } }));
    try {
      for (let index = 0; index < 50; index++) socket.send(inputs[index % inputs.length]);
      expect(allocations).toBe(0); expect(set).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled(); expect(bufferSlice).not.toHaveBeenCalled();
      native.send.mock.calls.forEach(([data], index) => expect(data).toBe(inputs[index % inputs.length]));
    } finally { vi.stubGlobal('Uint8Array', U8); vi.stubGlobal('ArrayBuffer', AB); }
  });
  test('retains native state, binaryType, event and close forwarding', () => {
    const { socket, native } = open(), message = vi.fn(), error = vi.fn(), close = vi.fn(), opened = vi.fn();
    socket.onmessage = message; socket.onerror = error; socket.onclose = close; socket.onopen = opened;
    socket.binaryType = 'arraybuffer'; expect(native.binaryType).toBe('arraybuffer');
    native.readyState = 3; expect(socket.readyState).toBe(3);
    native.onopen?.(); native.onmessage?.({ data: 'text' }); native.onerror?.(); native.onclose?.({ code: 1000, reason: 'done' });
    expect(opened).toHaveBeenCalledOnce(); expect(message).toHaveBeenCalledExactlyOnceWith({ data: 'text' }); expect(error).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledExactlyOnceWith({ code: 1000, reason: 'done' });
    socket.close(1000, 'done'); expect(native.close).toHaveBeenCalledExactlyOnceWith(1000, 'done');
  });
});
