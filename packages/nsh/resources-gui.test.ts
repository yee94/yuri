import { expect, it, vi } from 'vitest';
import { createResourceGuiFile, type ResourceGuiState } from './resources-gui';

const scope = { hostID: 'source-host', lease: 'source-receipt' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
it.each(['report.weird', 'unmatched.eficy', 'picture.png', 'paper.pdf', 'page.html', 'source.ts'])('production file callback consults the registry for %s without changing the native resource lane', async path => {
  const states: ResourceGuiState[] = [], present = vi.fn(async () => ({ closed: true as const, matched: false })), close = vi.fn(async () => {});
  const capture = vi.fn(expected => { expect(expected).toEqual(scope); expect(Object.isFrozen(expected)).toBe(true); return { present, close }; });
  const gui = createResourceGuiFile({ expectedHost: scope, active: () => true, capture, changed: state => states.push(state) });
  await gui.open({ directory: '/project', path });
  expect(present).toHaveBeenCalledWith({ directory: '/project', path });
  expect(states.at(-1)).toEqual({ preparing: false, matched: false, failed: false });
  await gui.open({ directory: '/project', path }); expect(present).toHaveBeenCalledTimes(1);
  await gui.dispose();
});
it('preserves explicit session, skips targetLine and allows manual preview after source/dismissal', async () => {
  const present = vi.fn(async () => ({ closed: true as const, matched: true })), capture = vi.fn(() => ({ present, close: async () => {} }));
  const gui = createResourceGuiFile({ expectedHost: scope, active: () => true, capture, changed() {} });
  const intent = { directory: '/p', path: '/p/registered.data', sessionId: 'actual-session' };
  await gui.open(intent, { targetLine: 5 }); expect(capture).not.toHaveBeenCalled();
  await gui.open(intent); expect(present).toHaveBeenCalledWith(intent);
  await gui.open(intent); expect(present).toHaveBeenCalledTimes(1);
  await gui.open(intent, { manual: true }); expect(present).toHaveBeenCalledTimes(2);
  await gui.dispose();
});
it('captures B before awaiting A close, and late A result cannot overwrite B', async () => {
  const a = deferred<{ closed: true; matched: boolean }>(), closingA = deferred<void>();
  const states: ResourceGuiState[] = [];
  let sequence = 0;
  const presentB = vi.fn(async () => ({ closed: true as const, matched: true }));
  const capture = vi.fn(() => ++sequence === 1 ? { present: () => a.promise, close: () => closingA.promise } : { present: presentB, close: async () => {} });
  const gui = createResourceGuiFile({ expectedHost: scope, active: () => true, capture, changed: value => states.push(value) });
  const first = gui.open({ directory: '/p', path: 'a.custom' }); await Promise.resolve();
  const second = gui.open({ directory: '/p', path: 'b.custom' });
  expect(capture).toHaveBeenCalledTimes(2); expect(presentB).not.toHaveBeenCalled();
  closingA.resolve(); await second;
  a.resolve({ closed: true, matched: false }); await first;
  expect(states.at(-1)).toEqual({ preparing: false, matched: true, failed: false });
});
it('a new failed context must close the previous live preview and leave native fallback', async () => {
  const pending = deferred<{ closed: true; matched: boolean }>();
  const close = vi.fn(async () => { pending.resolve({ closed: true, matched: true }); });
  let sequence = 0;
  const states: ResourceGuiState[] = [];
  const gui = createResourceGuiFile({ expectedHost: scope, active: () => true, changed: value => states.push(value), capture: () => {
    if (++sequence === 2) throw Error('canonical appearance unavailable');
    return { present: () => pending.promise, close };
  } });
  const first = gui.open({ directory: '/p', path: 'a.custom' }); await Promise.resolve();
  await gui.open({ directory: '/p', path: 'b.custom' });
  expect(close).toHaveBeenCalled();
  pending.resolve({ closed: true, matched: true }); await first;
  expect(states.at(-1)).toEqual({ preparing: false, matched: false, failed: true });
});
it('Host retirement/dispose closes only the captured owner and suppresses late result', async () => {
  const pending = deferred<{ closed: true; matched: boolean }>(), close = vi.fn(async () => {});
  const states: ResourceGuiState[] = []; let active = true;
  const gui = createResourceGuiFile({ expectedHost: scope, active: () => active, capture: () => ({ present: () => pending.promise, close }), changed: state => states.push(state) });
  const opened = gui.open({ directory: '/p', path: 'a.custom' }); await Promise.resolve();
  active = false; await gui.dispose(); pending.resolve({ closed: true, matched: true }); await opened;
  expect(states.at(-1)).toEqual({ preparing: false, matched: false, failed: false });
  expect(close).toHaveBeenCalled();
});
it.each(['switch', 'close', 'capture-failure'])('latest C waits for A retirement across an intervening %s', async mode => {
  const resultA = deferred<{ closed: true; matched: boolean }>(), closingA = deferred<void>();
  const presentB = vi.fn(async () => ({ closed: true as const, matched: false }));
  const presentC = vi.fn(async () => ({ closed: true as const, matched: true }));
  let captures = 0;
  const closeA = vi.fn(() => closingA.promise);
  const gui = createResourceGuiFile({ expectedHost: scope, active: () => true, changed() {}, capture() {
    captures++;
    if (captures === 1) return { present: () => resultA.promise, close: closeA };
    if (captures === 2 && mode === 'capture-failure') throw Error('context unavailable');
    return { present: captures === 2 && mode === 'switch' ? presentB : presentC, close: async () => {} };
  } });
  const a = gui.open({ directory: '/p', path: 'a' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const b = mode === 'close' ? gui.close() : gui.open({ directory: '/p', path: 'b' });
  const c = gui.open({ directory: '/p', path: 'c' });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(presentB).not.toHaveBeenCalled(); expect(presentC).not.toHaveBeenCalled();
  closingA.resolve(); resultA.resolve({ closed: true, matched: false });
  await Promise.all([a, b, c]);
  expect(presentC).toHaveBeenCalledOnce(); expect(closeA).toHaveBeenCalledOnce();
  await gui.dispose();
});

it('a registry miss cannot release the HTML lane before exact GUI retirement; failed close remains retryable and never means unmatched', async () => {
  const closing = deferred<void>(), unmatched = vi.fn(), states: ResourceGuiState[] = [];
  const close = vi.fn<() => Promise<void>>().mockReturnValueOnce(closing.promise).mockRejectedValueOnce(Error('retirement_failed')).mockResolvedValue(undefined);
  const gui = createResourceGuiFile({ expectedHost: scope, active: () => true, unmatched, changed: state => states.push(state),
    capture: () => ({ present: async () => ({ closed: true, matched: false }), close }) });
  const first = gui.open({ directory: '/p', path: '/p/a.html' });
  for (let index = 0; index < 12; index++) await Promise.resolve();
  expect(unmatched).not.toHaveBeenCalled(); closing.resolve(); await first; expect(unmatched).toHaveBeenCalledOnce();
  await gui.open({ directory: '/p', path: '/p/b.html' });
  expect(states.at(-1)?.failed).toBe(true); expect(unmatched).toHaveBeenCalledOnce();
  await gui.close(); expect(close).toHaveBeenCalledTimes(3);
});
