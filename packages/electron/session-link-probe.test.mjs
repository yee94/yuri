import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_LINK_PROBE_CHANNEL,
  SESSION_LINK_PROBE_RESULT_CHANNEL,
  createSessionLinkProbe,
  selectSessionLinkTarget,
} from './session-link-probe.mjs';

const makeWindow = (runtime, { loading = false, focused = false } = {}) => {
  const contents = new EventEmitter();
  contents.mainFrame = {};
  contents.sent = [];
  contents.loading = loading;
  contents.isLoading = () => contents.loading;
  contents.send = (channel, payload) => contents.sent.push({ channel, payload });
  return { __yuriRuntimeConfig: runtime, webContents: contents, isFocused: () => focused };
};

const setup = (timeoutMs = 1_000) => {
  const ipcMain = new EventEmitter();
  let next = 0;
  const probe = createSessionLinkProbe({ ipcMain, timeoutMs, createId: () => `req-${++next}` });
  const answer = (window, payload, sender = window.webContents, senderFrame = sender.mainFrame) => {
    const request = window.webContents.sent.at(-1).payload;
    ipcMain.emit(SESSION_LINK_PROBE_RESULT_CHANNEL, { sender, senderFrame }, { requestId: request.requestId, ...payload });
  };
  return { probe, answer };
};

const local = { apiBaseUrl: 'http://127.0.0.1:3000/api' };
const devbox = { apiBaseUrl: 'https://devbox.example/api' };

afterEach(() => vi.useRealTimers());

describe('session link probe', () => {
  it('routes to the only window whose runtime owns the session', async () => {
    const { probe, answer } = setup();
    const hub = makeWindow(local);
    const remote = makeWindow(devbox);
    const pending = probe.locate([hub, remote], 'ses_1');
    expect(hub.webContents.sent).toEqual([{ channel: SESSION_LINK_PROBE_CHANNEL, payload: { requestId: 'req-1', sessionId: 'ses_1' } }]);
    answer(hub, { status: 'not-found' });
    answer(remote, { status: 'found', directory: '/data/repo' });
    await expect(pending).resolves.toEqual({ outcome: 'found', window: remote, directory: '/data/repo' });
  });

  it('keeps every miss authoritative only when all windows answered', async () => {
    vi.useFakeTimers();
    const { probe, answer } = setup(500);
    const hub = makeWindow(local);
    const silent = makeWindow(devbox);
    const pending = probe.locate([hub, silent], 'ses_1');
    answer(hub, { status: 'not-found' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ outcome: 'unconfirmed' });

    const both = probe.locate([hub], 'ses_2');
    answer(hub, { status: 'not-found' });
    await expect(both).resolves.toEqual({ outcome: 'not-found' });
  });

  it('refuses to choose between different runtimes but merges windows on one runtime', async () => {
    const { probe, answer } = setup();
    const a = makeWindow(local);
    const b = makeWindow(devbox);
    const ambiguous = probe.locate([a, b], 'ses_1');
    answer(a, { status: 'found', directory: '/a' });
    answer(b, { status: 'found', directory: '/b' });
    await expect(ambiguous).resolves.toEqual({ outcome: 'ambiguous' });

    const first = makeWindow({ apiBaseUrl: 'https://devbox.example/other' });
    const focused = makeWindow(devbox, { focused: true });
    const merged = probe.locate([first, focused], 'ses_1');
    answer(first, { status: 'found', directory: '/b' });
    answer(focused, { status: 'found', directory: '/b' });
    await expect(merged).resolves.toMatchObject({ outcome: 'found', window: focused });
  });

  it('separates relay connections from the loopback runtime they tunnel through', () => {
    const relay = makeWindow({ apiBaseUrl: local.apiBaseUrl, relayHostId: 'relay-1' });
    const hub = makeWindow(local);
    expect(selectSessionLinkTarget([
      { window: relay, status: 'found', directory: '/r' },
      { window: hub, status: 'found', directory: '/l' },
    ])).toEqual({ outcome: 'ambiguous' });
  });

  it('ignores answers from other senders and subframes, and treats malformed hits as errors', async () => {
    const { probe, answer } = setup();
    const target = makeWindow(devbox);
    const other = makeWindow(local);
    const pending = probe.locate([target], 'ses_1');
    answer(target, { status: 'found', directory: '/spoof' }, other.webContents);
    answer(target, { status: 'found', directory: '/spoof' }, target.webContents, {});
    answer(target, { status: 'found', directory: '  ' });
    answer(target, { status: 'found', directory: '/late' });
    await expect(pending).resolves.toEqual({ outcome: 'unconfirmed' });
  });

  it('waits for a loading window and reports destroyed windows as unchecked', async () => {
    const { probe, answer } = setup();
    const loading = makeWindow(devbox, { loading: true });
    const doomed = makeWindow(local);
    const pending = probe.locate([loading, doomed], 'ses_1');
    expect(loading.webContents.sent).toEqual([]);
    loading.webContents.loading = false;
    loading.webContents.emit('did-finish-load');
    answer(loading, { status: 'not-found' });
    doomed.webContents.emit('destroyed');
    await expect(pending).resolves.toEqual({ outcome: 'unconfirmed' });
  });
});
