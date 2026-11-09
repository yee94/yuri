import { expect, test, vi } from 'vitest';
import { desktopPanelChatStreamSupported, loadDesktopPanelChatNativeStream } from './desktop-panel-chat-native-stream';

const capability = { schemaVersion: 1, panelChat: { supported: true, maxStreams: 4, keyFormat: 'panel-chat:<owner>:<activation>', maxID: Number.MAX_SAFE_INTEGER, path: '/api/event', queryKeys: ['directory'], requiresExpectedHost: true } };
const scope = { hostID: 'native-host', lease: 'captured-lease' };

test('missing, failed or incomplete native capability never creates a stream or guesses support', async () => {
  for (const value of [null, {}, { supported: true }, { ...capability, schemaVersion: 2 }, ...Object.keys(capability.panelChat).map(key => ({ ...capability, panelChat: { ...capability.panelChat, [key]: undefined } }))]) {
    const call = vi.fn(async () => value);
    expect(desktopPanelChatStreamSupported(value)).toBe(false); expect(await loadDesktopPanelChatNativeStream(call)).toBeUndefined();
    expect(call).toHaveBeenCalledExactlyOnceWith('runtime.stream.capabilities', {});
  }
  const rejected = vi.fn(async () => { throw new Error('Native method unavailable'); });
  expect(await loadDesktopPanelChatNativeStream(rejected)).toBeUndefined(); expect(rejected).toHaveBeenCalledTimes(1);
});

test('discovery performs no network; each start/stop forwards only its captured key and lease through the existing native boundary', async () => {
  const call = vi.fn(async () => capability), port = await loadDesktopPanelChatNativeStream(call);
  expect(call).toHaveBeenCalledTimes(1); expect(port).toBeDefined();
  const start = { key: 'panel-chat:23:1', path: '/api/event?directory=%2Frepo%20one', expectedHost: scope };
  await port!.start(start); await port!.stop({ key: start.key, expectedHost: scope });
  expect(call.mock.calls).toEqual([
    ['runtime.stream.capabilities', {}], ['runtime.stream', start], ['runtime.stop', { key: start.key, expectedHost: scope }],
  ]);
});

test('a delayed capability response cannot create a speculative stream before native discovery finishes', async () => {
  let release: (value: unknown) => void = () => { throw new Error('Capability was not requested'); };
  const call = vi.fn((_name: string, _input: Record<string, unknown>) => new Promise(resolve => { release = resolve; }));
  const pending = loadDesktopPanelChatNativeStream(call);
  expect(call).toHaveBeenCalledExactlyOnceWith('runtime.stream.capabilities', {});
  release(capability); const port = await pending;
  expect(port).toBeDefined(); expect(call).toHaveBeenCalledTimes(1);
});

test('the display adapter cannot start or stop main streams, malformed IDs, ambiguous routes, or unscoped requests', async () => {
  const call = vi.fn(async () => capability), port = (await loadDesktopPanelChatNativeStream(call))!;
  for (const key of ['chat', 'global', 'panel-chat:0:1', 'panel-chat:01:1', 'panel-chat:1:1e1', 'panel-chat:1:9007199254740992', 'panel-chat:1:1:1']) {
    expect(() => port.start({ key, path: '/api/event?directory=%2Frepo', expectedHost: scope })).toThrow();
    expect(() => port.stop({ key, expectedHost: scope })).toThrow();
  }
  for (const path of ['/api/yuri/events', '/api/event?directory=%2frepo', '/api/event?directory=%2Frepo&token=unexpected', '/api/event?directory=%00', '/api/event?directory=%', '/api/event?directory=']) expect(() => port.start({ key: 'panel-chat:1:1', path, expectedHost: scope })).toThrow();
  expect(() => port.stop({ key: 'panel-chat:1:1', expectedHost: { hostID: '', lease: '' } })).toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});
