import { expect, test, vi } from 'vitest';
import { createNativeAutoReadAwake } from './native-auto-read-awake';

function deferred() {
  let resolve!: (held: boolean) => void;
  const promise = new Promise<boolean>(yes => { resolve = yes; });
  return { promise, resolve };
}
test('one speech-owned awake request per lifecycle edge, never per token or playing-message change', async () => {
  const awake = vi.fn(async (enabled: boolean) => enabled), failure = vi.fn();
  const owner = createNativeAutoReadAwake({ awake, failed: failure, changed: () => {} });
  owner.update(true, 'host/a');
  for (let index = 0; index < 100; index++) owner.update(true, 'host/a');
  await Promise.resolve();
  expect(awake.mock.calls).toEqual([[true]]);
  expect(owner.state()).toBe('held');
  owner.update(false, 'host/a'); await Promise.resolve();
  expect(awake.mock.calls).toEqual([[true], [false]]);
  expect(failure).not.toHaveBeenCalled();
  await owner.dispose(); expect(awake).toHaveBeenCalledTimes(2);
});

test('unsupported is an explicit non-looping warning; scope switch and disposal release the same owner', async () => {
  const awake = vi.fn(async () => false), failure = vi.fn();
  const owner = createNativeAutoReadAwake({ awake, failed: failure, changed: () => {} });
  owner.update(true, 'host/a'); await Promise.resolve();
  expect(owner.state()).toBe('unsupported'); expect(failure).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 100; index++) owner.update(true, 'host/a');
  expect(awake).toHaveBeenCalledTimes(1);
  owner.update(true, 'host/b'); await Promise.resolve();
  expect(awake.mock.calls).toEqual([[true], [false], [true]]);
  await owner.dispose();
  expect(awake.mock.calls).toEqual([[true], [false], [true], [false]]);
});

test('late acquisition settlement after hiding never revives state or warns for an old scope', async () => {
  const pending = deferred(), failure = vi.fn();
  const awake = vi.fn(async (enabled: boolean) => enabled ? pending.promise : false);
  const owner = createNativeAutoReadAwake({ awake, failed: failure, changed: () => {} });
  owner.update(true, 'host/a'); owner.update(false, 'host/a');
  pending.resolve(false); await Promise.resolve(); await Promise.resolve();
  expect(owner.state()).toBe('idle'); expect(failure).not.toHaveBeenCalled();
  expect(awake.mock.calls).toEqual([[true], [false]]);
});

test('transport failure warns once without stopping/retrying automatic speech, and cleanup failures reject', async () => {
  const failure = vi.fn(), awake = vi.fn(async (_enabled: boolean) => { throw new Error('Synthetic awake failure'); });
  const owner = createNativeAutoReadAwake({ awake, failed: failure, changed: () => {} });
  owner.update(true, 'host/a');
  await vi.waitFor(() => expect(owner.state()).toBe('error'));
  for (let index = 0; index < 100; index++) owner.update(true, 'host/a');
  expect(failure).toHaveBeenCalledTimes(1); expect(awake).toHaveBeenCalledTimes(1);
  await expect(owner.dispose()).rejects.toThrow('Synthetic awake failure');
  expect(awake.mock.calls).toEqual([[true], [false]]);
});
