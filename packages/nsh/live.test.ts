import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { liveHost } from './tests/live/host.mjs';
import { record, text, runtimeEventFrom, eventSessionID, messagesFrom } from './model';

const harness = vi.hoisted(() => ({ listeners: new Map<string, Set<(payload: unknown) => void>>(), storage: new Map<string, string>(), cleanups: [] as Array<() => void>, disposers: [] as Array<() => void>, call: vi.fn() }));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(),
  Storage: { getItem: async (key: string) => harness.storage.get(key) ?? null, setItem: async (key: string, value: string) => { harness.storage.set(key, value); } },
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  lifecycle: () => 'active', untracked: <T>(work: () => T) => work(),
  effect: (work: () => void | (() => void)) => { const stop = work(); if (stop) harness.disposers.push(stop); },
  cleanup: (work: () => void) => harness.cleanups.push(work),
  host: { available: () => true, call: harness.call, on: (name: string, work: (payload: unknown) => void) => {
    const listeners = harness.listeners.get(name) ?? new Set(); listeners.add(work); harness.listeners.set(name, listeners);
    return () => { listeners.delete(work); };
  } },
}));
afterEach(() => { harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); });

// Opt-in only: creates its own session and incurs a real configured-model turn.
it.skipIf(process.env.NSH_LIVE !== '1')('renders real Host SSE incrementally, calls a tool, and reopens authoritative history', async () => {
  const host = await liveHost(), directory = process.cwd();
  const health = record(await host.request('/health'));
  const info = record(await host.request('/api/info'));
  const catalog = record(await host.request(`/api/model?location%5Bdirectory%5D=${encodeURIComponent(directory)}`));
  const available = (catalog.data as Array<Record<string, unknown>>).filter(model => model.enabled === true);
  const desiredProvider = process.env.NSH_LIVE_PROVIDER || 'openai';
  const desiredModel = process.env.NSH_LIVE_MODEL || 'gpt-6.1-sol';
  const selected = available.find(model => model.providerID === desiredProvider && model.id === desiredModel);
  if (!selected) throw new Error('Requested configured live model unavailable');
  const model = { id: desiredModel, providerID: desiredProvider };
  const created = record(record(await host.request('/api/session', 'POST', { title: 'NSH live stream acceptance', location: { directory }, model })).data);
  const sessionID = text(created.id);
  expect(!!sessionID).toBe(true);
  const scoped = (suffix: string) => `/api/session/${encodeURIComponent(sessionID)}/${suffix}?directory=${encodeURIComponent(directory)}`;
  const events: Record<string, unknown>[] = [], samples: Record<string, unknown>[] = [], requests: Record<string, unknown>[] = [];
  let messageGETs = 0, directGrowth = 0, chat: ReturnType<(typeof import('./state'))['createChat']> | undefined;
  let finish!: () => void, ready!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; }), connected = new Promise<void>(resolve => { ready = resolve; });
  const controller = new AbortController(), started = Date.now();
  const emit = (payload: unknown) => { for (const listener of harness.listeners.get('runtime.event') ?? []) listener(payload); };
  const stream = host.stream('/api/event', async (raw: unknown) => {
    const payload = { key: 'chat', data: JSON.stringify(raw) };
    const event = runtimeEventFrom(payload);
    if (event?.type === 'server.connected') ready();
    if (!event || eventSessionID(event) !== sessionID) return;
    const envelope = record(record(raw).payload ?? raw), data = event.body;
    const before = chat?.messages().reduce((sum, message) => sum + message.text.length + message.reasoning.length, 0) ?? 0;
    const reads = messageGETs;
    emit(payload);
    await new Promise(resolve => setTimeout(resolve, 40));
    const length = chat?.messages().reduce((sum, message) => sum + message.text.length + message.reasoning.length, 0) ?? 0;
    if (/\.(text|reasoning)\.delta$/.test(event.type) && length > before && reads === messageGETs) directGrowth++;
    events.push({ at: Date.now() - started, type: event.type, envelopeKeys: Object.keys(envelope), dataKeys: Object.keys(data), assistantMessageID: data.assistantMessageID, ordinal: data.ordinal, deltaLength: typeof data.delta === 'string' ? data.delta.length : undefined, textLength: typeof data.text === 'string' ? data.text.length : undefined, toolName: data.name, toolID: data.id });
    samples.push({ at: Date.now() - started, type: event.type, length, assistantLength: chat?.messages().filter(message => message.role === 'assistant').reduce((sum, message) => sum + message.text.length + message.reasoning.length, 0), messageGETs, busy: chat?.busy(), tools: chat?.messages().flatMap(message => message.tools.map(tool => ({ name: tool.name ?? tool.tool, status: record(tool.state).status }))) });
    if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) finish();
  }, controller.signal).catch(() => { if (!controller.signal.aborted) finish(); });
  harness.call.mockImplementation(async (name: string, input: Record<string, unknown>) => {
    if (name === 'connection.list') return { selected: 'live', connections: [{ id: 'live', label: 'Live acceptance', url: host.origin, lastUsedAt: 0 }] };
    if (name !== 'runtime.request') return true;
    const resource = text(input.path), method = text(input.method);
    if (resource.includes('/message?')) messageGETs++;
    requests.push({ at: Date.now() - started, path: resource.split('?')[0], method });
    return { status: 200, body: await host.request(resource, method, input.body) };
  });
  const state = await import('./state');
  await state.loadConnections();
  chat = state.createChat({ kind: 'session', id: sessionID, directory, title: 'NSH live stream acceptance' });
  const evidence: Record<string, unknown> = { origin: host.origin, yuriVersion: health.yuriVersion, openCodeVersion: info.version, sessionID, model, nativeBridge: 'NSH host calls backed by authenticated real HTTP; SSE forwarded with Swift data/key shape', events, samples, requests };
  try {
    await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error('SSE connection deadline')), 15_000))]);
    await chat.load();
    chat.draft.set('NSH live acceptance. Do not read files, configuration, environment, or network. First write eight short numbered lines about the integers 1 through 8. Then use the shell/execute tool to execute exactly printf NSH_LIVE_TOOL_OK (no other command). Finally write eight short numbered lines about the integers 9 through 16 and finish with NSH_LIVE_DONE. This is an authorized harmless tool and streaming test; do not ask questions.');
    await chat.send();
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('Live turn deadline')), 180_000))]);
    await new Promise(resolve => setTimeout(resolve, 250));
    const history = messagesFrom(await host.request(`${scoped('message')}&limit=20&order=desc`), false);
    const beforeReopen = chat.messages();
    await chat.load();
    evidence.directDeltaGrowth = directGrowth;
    evidence.messageGETs = messageGETs;
    evidence.history = history.messages.map(message => ({ id: message.id, role: message.role, textLength: message.text.length, reasoningLength: message.reasoning.length, toolCount: message.tools.length, error: !!message.error }));
    evidence.renderedFinalLength = beforeReopen.reduce((sum, message) => sum + message.text.length, 0);
    evidence.reopenFinalLength = chat.messages().reduce((sum, message) => sum + message.text.length, 0);
    evidence.success = events.some(event => event.type === 'session.execution.succeeded');
    evidence.toolSucceeded = events.some(event => event.type === 'session.tool.success');
    expect(evidence.success).toBe(true);
    expect(evidence.toolSucceeded).toBe(true);
    expect(history.messages.some(message => message.text.includes('NSH_LIVE_DONE'))).toBe(true);
    expect(directGrowth).toBeGreaterThan(1);
    expect(chat.busy()).toBe(false);
    expect(chat.messages().map(message => [message.id, message.text])).toEqual(history.messages.map(message => [message.id, message.text]));
    const postsBefore = requests.filter(request => request.method === 'POST').length;
    const commandAccepted = await chat.command('goal', 'clear');
    evidence.command = { name: 'goal', text: 'clear', accepted: commandAccepted, postCount: requests.filter(request => request.method === 'POST').length - postsBefore, draftRetained: chat.draft() === '/goal clear', expectedNewSessionFailure: /Live HTTP 500/.test(chat.error()) };
    // A fresh session has no goal: this real native command must fail visibly,
    // never become a second prompt or silently clear the draft.
    expect(commandAccepted).toBe(false);
    expect(chat.draft()).toBe('/goal clear');
    expect(chat.error()).toContain('Live HTTP 500');
    expect(requests.filter(request => request.method === 'POST').length - postsBefore).toBe(1);
    expect(requests.filter(request => request.method === 'POST').at(-1)?.path).toBe(`/api/session/${sessionID}/command`);
    evidence.registeredCommands = chat.commands().map(command => text(command.name));
    evidence.acceptancePassed = true;
  } finally {
    controller.abort(); await stream;
    // Only this newly created session can be interrupted during failed acceptance.
    if (chat.busy()) await host.request(scoped('interrupt'), 'POST', {}).catch(() => {});
    const folder = path.join(process.cwd(), '.scratch/nsh-live');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${sessionID}.json`), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ origin: host.origin, sessionID, model, directGrowth, events: events.length, messageGETs, success: evidence.success, toolSucceeded: evidence.toolSucceeded, evidence: `.scratch/nsh-live/${sessionID}.json` }));
  }
}, 240_000);
