import { expect, test, vi } from 'vitest';
import { createDesktopPageDeparture, type DesktopPageDepartureOwner } from './desktop-page-departure';

function fixture() {
  let scope = 'authority-a', current = true, canClose = false;
  const intent = vi.fn(), onError = vi.fn(), leave = vi.fn(async (_commit: () => void) => {}), close = vi.fn(async () => false);
  const release = vi.fn();
  const owner: DesktopPageDepartureOwner = { current: () => current, requestLeave: leave, release, requestClose: close, canClose: () => canClose };
  const departure = createDesktopPageDeparture({ scope: () => scope, onIntent: intent, onError });
  departure.bind(owner);
  return { departure, owner, intent, onError, leave, close, release, scope: (value: string) => { scope = value; }, current: (value: boolean) => { current = value; }, allowClose: (value: boolean) => { canClose = value; } };
}

test('cancellation preserves the editor and records intent before any confirmation', async () => {
  const f = fixture(), commit = vi.fn();
  f.leave.mockImplementation(async () => { expect(f.intent).toHaveBeenCalledTimes(1); });
  expect(await f.departure.request(commit)).toBe(false);
  expect(commit).not.toHaveBeenCalled(); expect(f.departure.canClose()).toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  f.leave.mockImplementation(async done => { done(); done(); });
  expect(await f.departure.request(commit)).toBe(true); expect(commit).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
});

test.each(['scope', 'owner', 'dispose'] as const)('late confirmation cannot publish after %s retirement', async reason => {
  const f = fixture(), commit = vi.fn(); let finish!: () => void;
  f.leave.mockImplementation(done => new Promise<void>(resolve => { finish = () => { done(); resolve(); }; }));
  const pending = f.departure.request(commit);
  if (reason === 'scope') f.scope('authority-b');
  else if (reason === 'owner') f.departure.bind({ ...f.owner });
  else f.departure.dispose();
  finish(); expect(await pending).toBe(false); expect(commit).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test('one confirmation rejects another intent, then a committed release permits synchronous route publication', async () => {
  const f = fixture(), other = vi.fn(); let finish!: () => void;
  f.leave.mockImplementation(done => new Promise<void>(resolve => { finish = () => { done(); resolve(); }; }));
  f.release.mockImplementation(() => { f.current(false); });
  const pending = f.departure.request(() => { expect(f.release).toHaveBeenCalledTimes(1); void f.departure.request(other); });
  expect(await f.departure.request(other)).toBe(false); expect(other).not.toHaveBeenCalled();
  finish(); expect(await pending).toBe(true); expect(other).toHaveBeenCalledTimes(1);
});

test.each(['scope', 'owner', 'dispose'] as const)('native close grant cannot survive %s retirement or release a page', async reason => {
  const f = fixture(); let finish!: () => void;
  f.allowClose(true);
  f.close.mockImplementation(() => new Promise<boolean>(resolve => { finish = () => resolve(true); }));
  const pending = f.departure.requestClose();
  expect(f.departure.canClose()).toBe(false);
  if (reason === 'scope') f.scope('authority-b');
  else if (reason === 'owner') f.departure.bind({ ...f.owner });
  else f.departure.dispose();
  finish(); expect(await pending).toBe(false); expect(f.release).not.toHaveBeenCalled(); expect(f.leave).not.toHaveBeenCalled();
});

test('native close requests never invoke navigation and require a final unchanged editor grant', async () => {
  const f = fixture(); f.close.mockResolvedValue(true);
  expect(await f.departure.requestClose()).toBe(false);
  f.allowClose(true); expect(await f.departure.requestClose()).toBe(true);
  expect(f.leave).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  f.allowClose(false); expect(f.departure.canClose()).toBe(false);
  f.allowClose(true); expect(f.departure.canClose()).toBe(true);
});

test('stale unbind cannot release a replacement editor; failures preserve its close gate', async () => {
  const f = fixture(), unbind = f.departure.bind(f.owner), next = { ...f.owner };
  f.departure.bind(next); unbind();
  f.close.mockRejectedValue(new Error('synthetic close failure'));
  expect(await f.departure.requestClose()).toBe(false); expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.onError).toHaveBeenCalledTimes(1); expect(f.departure.canClose()).toBe(false);
});

test('optional validation vetoes a no-owner commit but retains the startup intent veto', async () => {
  const intent = vi.fn(), commit = vi.fn(), validate = vi.fn(() => false);
  const departure = createDesktopPageDeparture({ scope: () => null, onIntent: intent, onError: vi.fn() });
  expect(await departure.request(commit, validate)).toBe(false);
  expect(validate).toHaveBeenCalledTimes(1); expect(intent).toHaveBeenCalledTimes(1); expect(commit).not.toHaveBeenCalled();
  expect(await departure.request(commit)).toBe(true); expect(commit).toHaveBeenCalledTimes(1); expect(intent).toHaveBeenCalledTimes(2);
});

test('optional final validation happens inside the retained owner callback before release, not merely inside commit', async () => {
  const f = fixture(), commit = vi.fn(); let valid = true, finish!: () => void;
  f.leave.mockImplementation(done => new Promise<void>(resolve => { finish = () => { done(); resolve(); }; }));
  const pending = f.departure.request(commit, () => valid);
  valid = false; finish(); expect(await pending).toBe(false);
  expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(f.intent).toHaveBeenCalledTimes(1);
  valid = true; finish(); expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
});

test('optional validation preserves release-before-commit and cannot affect native close semantics', async () => {
  const f = fixture(), validate = vi.fn(() => true), commit = vi.fn(() => { expect(f.release).toHaveBeenCalledTimes(1); });
  f.leave.mockImplementation(async done => { done(); done(); });
  expect(await f.departure.request(commit, validate)).toBe(true);
  expect(validate).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1);
  f.close.mockResolvedValue(true); f.allowClose(true);
  expect(await f.departure.requestClose()).toBe(true);
  expect(validate).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
});

test('a throwing owner final validator is a failed closed departure, never an early release', async () => {
  const f = fixture(), commit = vi.fn();
  f.leave.mockImplementation(async done => { done(); });
  expect(await f.departure.request(commit, () => { throw new Error('synthetic invalid guard'); })).toBe(false);
  expect(f.onError).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('async beforeCommit runs after business approval and keeps the editor mounted through admission', async () => {
  const f = fixture(), admission = deferred<boolean>(), commit = vi.fn();
  f.allowClose(true); f.leave.mockImplementation(async done => { done(); done(); });
  const beforeCommit = vi.fn(() => admission.promise);
  const pending = f.departure.request(commit, () => true, beforeCommit);
  await Promise.resolve(); expect(beforeCommit).toHaveBeenCalledTimes(1);
  expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  admission.resolve(true); expect(await pending).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1);
});

test.each(['scope', 'owner', 'dispose', 'validation', 'edit'] as const)('async admission final revalidation preserves the editor after %s changes', async reason => {
  const f = fixture(), admission = deferred<boolean>(), commit = vi.fn(); let valid = true;
  f.allowClose(true); f.leave.mockImplementation(async done => { done(); });
  const pending = f.departure.request(commit, () => valid, () => admission.promise); await Promise.resolve();
  if (reason === 'scope') f.scope('host-b');
  else if (reason === 'owner') f.departure.bind({ ...f.owner });
  else if (reason === 'dispose') f.departure.dispose();
  else if (reason === 'validation') valid = false;
  else f.allowClose(false);
  admission.resolve(true); expect(await pending).toBe(false);
  expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
});

test('async hook requires a revalidatable editor grant, not merely a past callback', async () => {
  const f = fixture(), beforeCommit = vi.fn(async () => true);
  f.leave.mockImplementation(async done => { done(); });
  expect(await f.departure.request(vi.fn(), () => true, beforeCommit)).toBe(false);
  expect(beforeCommit).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test.each(['veto', 'error'] as const)('async admission %s preserves editor and is fully awaited', async outcome => {
  const f = fixture(), commit = vi.fn(); f.allowClose(true);
  f.leave.mockImplementation(async done => { done(); });
  const beforeCommit = vi.fn(async () => { if (outcome === 'error') throw new Error('synthetic release failure'); return false; });
  expect(await f.departure.request(commit, () => true, beforeCommit)).toBe(false);
  expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledTimes(outcome === 'error' ? 1 : 0);
});

test('no editor still awaits admission and rejects changed Host scope', async () => {
  let scope = 'host-a'; const admission = deferred<boolean>(), commit = vi.fn();
  const page = createDesktopPageDeparture({ scope: () => scope, onIntent: vi.fn(), onError: vi.fn() });
  const pending = page.request(commit, () => true, () => admission.promise); await Promise.resolve();
  expect(commit).not.toHaveBeenCalled(); scope = 'host-b'; admission.resolve(true);
  expect(await pending).toBe(false); expect(commit).not.toHaveBeenCalled();
  expect(await page.request(commit, () => true, async () => true)).toBe(true);
});

test('a callback arriving after requestLeave completes cannot start a late native release', async () => {
  const f = fixture(), commit = vi.fn(), beforeCommit = vi.fn(async () => true); let late!: () => void;
  f.allowClose(true); f.leave.mockImplementation(async done => { late = done; });
  expect(await f.departure.request(commit, () => true, beforeCommit)).toBe(false);
  late(); await Promise.resolve();
  expect(beforeCommit).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
});

test('async admission clears pending before release/commit so nested navigation confirms only once', async () => {
  const f = fixture(), nested = vi.fn(); f.allowClose(true);
  f.leave.mockImplementation(async done => { done(); }); f.release.mockImplementation(() => f.current(false));
  expect(await f.departure.request(() => { void f.departure.request(nested); }, () => true, async () => true)).toBe(true);
  expect(f.leave).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1); expect(nested).toHaveBeenCalledTimes(1);
});

test('a rejected requestLeave still awaits its already-started admission and never commits', async () => {
  const f = fixture(), admission = deferred<boolean>(), commit = vi.fn(); let settled = false;
  f.allowClose(true); f.leave.mockImplementation(async done => { done(); throw new Error('synthetic leave failure'); });
  const pending = f.departure.request(commit, () => true, () => admission.promise).then(value => { settled = true; return value; });
  await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  admission.resolve(true); expect(await pending).toBe(false);
  expect(f.release).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(f.onError).toHaveBeenCalledTimes(1);
});

test('no-editor async admission still excludes a second navigation or native close until settled', async () => {
  const admission = deferred<boolean>(), commit = vi.fn(), competing = vi.fn();
  const page = createDesktopPageDeparture({ scope: () => 'host', onIntent: vi.fn(), onError: vi.fn() });
  const pending = page.request(commit, () => true, () => admission.promise); await Promise.resolve();
  expect(await page.request(competing)).toBe(false); expect(await page.requestClose()).toBe(false);
  expect(page.canClose()).toBe(false); expect(competing).not.toHaveBeenCalled();
  admission.resolve(true); expect(await pending).toBe(true); expect(commit).toHaveBeenCalledTimes(1);
  expect(await page.requestClose()).toBe(true);
});

test('opaque root action metadata is still ignored rather than mistaken for an asynchronous hook', async () => {
  const f = fixture(), commit = vi.fn();
  f.leave.mockImplementation(async done => { done(); });
  expect(await f.departure.request(commit, () => true, 'switch')).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1); expect(f.onError).not.toHaveBeenCalled();
});
