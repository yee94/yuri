import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireMobileHtmlNetwork } from './mobile-html-network';

const fixture = vi.hoisted(() => ({ generation: 1, open: vi.fn(), release: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/gui-plugins/mobile-network', () => ({ openMobileGuiNetwork: (...args: unknown[]) => fixture.open(...args) }));
const owners: AbortController[] = [];
const owner = () => { const value = new AbortController(); owners.push(value); return value; };
beforeEach(() => {
  fixture.generation = 1;
  fixture.release.mockReset().mockResolvedValue(undefined);
  fixture.open.mockReset().mockResolvedValue({ hostOrigin: 'http://localhost:4000', release: fixture.release });
});
afterEach(async () => {
  owners.splice(0).forEach(value => value.abort());
  await new Promise(resolve => setTimeout(resolve, 0));
});

it('shares one gateway between a GUI host and HTML views, releasing only the last owner', async () => {
  const a = owner(); const b = owner();
  const [gui, html] = await Promise.all([
    acquireMobileHtmlNetwork(a.signal, vi.fn()), acquireMobileHtmlNetwork(b.signal, vi.fn()),
  ]);
  expect(fixture.open).toHaveBeenCalledOnce();
  expect(html.hostOrigin).toBe('http://localhost:4000');
  await html.release();
  expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.open.mock.calls[0][0].aborted).toBe(false);
  await gui.release();
  expect(fixture.open.mock.calls[0][0].aborted).toBe(true);
  expect(fixture.release).toHaveBeenCalledOnce();
});

it('cancels one waiting view without cancelling a GUI host sharing startup', async () => {
  let ready!: (value: { release: typeof fixture.release }) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
  const a = owner(); const b = owner();
  const pending = acquireMobileHtmlNetwork(a.signal, vi.fn());
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const retained = acquireMobileHtmlNetwork(b.signal, vi.fn());
  await vi.waitFor(() => expect(ready).toBeDefined());
  a.abort(); await rejected;
  expect(fixture.open.mock.calls[0][0].aborted).toBe(false);
  ready({ release: fixture.release });
  await (await retained).release();
});

it('notifies all consumers, keeps failed egress until both dispose, then permits a retry', async () => {
  const a = owner(); const b = owner(); const failedA = vi.fn(); const failedB = vi.fn();
  const first = await acquireMobileHtmlNetwork(a.signal, failedA);
  const second = await acquireMobileHtmlNetwork(b.signal, failedB);
  fixture.open.mock.calls[0][1]();
  expect(failedA).toHaveBeenCalledOnce(); expect(failedB).toHaveBeenCalledOnce();
  await expect(acquireMobileHtmlNetwork(owner().signal, vi.fn())).rejects.toThrow('relay_unavailable');
  await first.release(); expect(fixture.release).not.toHaveBeenCalled();
  await second.release(); expect(fixture.release).toHaveBeenCalledOnce();
  await (await acquireMobileHtmlNetwork(owner().signal, vi.fn())).release();
  expect(fixture.open).toHaveBeenCalledTimes(2);
});

it('does not share a gateway across runtime generations or accept a late old result', async () => {
  let ready!: (value: { release: typeof fixture.release }) => void;
  fixture.open.mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
  const old = acquireMobileHtmlNetwork(owner().signal, vi.fn());
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(ready).toBeDefined());
  fixture.generation++;
  const next = await acquireMobileHtmlNetwork(owner().signal, vi.fn());
  ready({ release: fixture.release }); await rejected;
  expect(fixture.open).toHaveBeenCalledTimes(2);
  await next.release();
});
