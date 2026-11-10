import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireMobileHtmlNetwork } from './mobile-html-network';

const fixture = vi.hoisted(() => ({ generation: 1, open: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/gui-plugins/mobile-network', () => ({ openMobileGuiNetwork: (...args: unknown[]) => fixture.open(...args) }));
const owners: AbortController[] = [];
const owner = () => { const value = new AbortController(); owners.push(value); return value; };
const network = () => ({ connect: fixture.connect, release: fixture.release });
beforeEach(() => {
  fixture.generation = 1;
  fixture.release.mockReset().mockResolvedValue(undefined);
  fixture.connect.mockReset().mockResolvedValue({ hostOrigin: 'http://localhost:4000' });
  fixture.open.mockReset().mockImplementation(async () => network());
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
  expect(fixture.connect).not.toHaveBeenCalled();
  expect(await html.connect()).toEqual({ hostOrigin: 'http://localhost:4000' });
  expect(fixture.connect).toHaveBeenCalledWith(b.signal);
  await html.release();
  expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.open.mock.calls[0][0].aborted).toBe(false);
  await gui.release();
  expect(fixture.open.mock.calls[0][0].aborted).toBe(true);
  expect(fixture.release).toHaveBeenCalledOnce();
});

it('cancels one waiting view without cancelling a GUI host sharing startup', async () => {
  let ready!: (value: ReturnType<typeof network>) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
  const a = owner(); const b = owner();
  const pending = acquireMobileHtmlNetwork(a.signal, vi.fn());
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const retained = acquireMobileHtmlNetwork(b.signal, vi.fn());
  await vi.waitFor(() => expect(ready).toBeDefined());
  a.abort(); await rejected;
  expect(fixture.open.mock.calls[0][0].aborted).toBe(false);
  ready(network());
  await (await retained).release();
});

it('notifies every owner on channel loss while the shared lease stays usable', async () => {
  const failedA = vi.fn(); const failedB = vi.fn();
  const first = await acquireMobileHtmlNetwork(owner().signal, failedA);
  const second = await acquireMobileHtmlNetwork(owner().signal, failedB);
  fixture.open.mock.calls[0][1]();
  expect(failedA).toHaveBeenCalledOnce(); expect(failedB).toHaveBeenCalledOnce();
  const third = await acquireMobileHtmlNetwork(owner().signal, vi.fn());
  expect(fixture.open).toHaveBeenCalledOnce();
  await first.release(); await second.release();
  expect(fixture.release).not.toHaveBeenCalled();
  await third.release();
  expect(fixture.release).toHaveBeenCalledOnce();
});

it('does not share a failed open, so the next owner retries', async () => {
  fixture.open.mockRejectedValueOnce(new Error('relay_required'));
  await expect(acquireMobileHtmlNetwork(owner().signal, vi.fn())).rejects.toThrow('relay_required');
  await (await acquireMobileHtmlNetwork(owner().signal, vi.fn())).release();
  expect(fixture.open).toHaveBeenCalledTimes(2);
});

it('does not share a gateway across runtime generations or accept a late old result', async () => {
  let ready!: (value: ReturnType<typeof network>) => void;
  fixture.open.mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
  const old = acquireMobileHtmlNetwork(owner().signal, vi.fn());
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(ready).toBeDefined());
  fixture.generation++;
  const next = await acquireMobileHtmlNetwork(owner().signal, vi.fn());
  ready(network()); await rejected;
  expect(fixture.open).toHaveBeenCalledTimes(2);
  await next.release();
});
