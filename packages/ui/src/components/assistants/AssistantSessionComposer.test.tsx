import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SessionIndexSession, SessionIndexSnapshot } from '@/lib/session-index-api';

const runtime = vi.hoisted(() => ({ transport: 'runtime-a', load: vi.fn(), dictationEnabled: true }));
const speech = vi.hoisted(() => ({ renders: vi.fn(), deliver: (_text: string) => {}, start: vi.fn(), confirm: vi.fn(), cancel: vi.fn() }));
const remote = vi.hoisted(() => ({ enabled: false, catalogReads: vi.fn(), summaryReads: vi.fn() }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  supportsRemoteProjects: () => remote.enabled,
  ensureRemoteHostCatalog: vi.fn(),
  useRemoteProjectRuntime: () => {
    remote.catalogReads();
    return remote.enabled ? { catalog: { hubId: 'hub', hosts: ['a', 'b'].map((id) => ({ id, name: `Host ${id}`, instanceId: `instance-${id}` })), projects: ['a', 'b'].map((hostId) => ({ hostId })) }, registry: {} } : {};
  },
  remoteHostSummariesQueryOptions: (_registry: unknown, hostId: string) => ({ queryKey: ['remote-summary', hostId], staleTime: Infinity,
    queryFn: () => { remote.summaryReads(hostId); return { directories: [{ directory: '/repo', sessions: [{ id: 'same', title: `Remote ${hostId}`, time: { created: 1, updated: 30 } }] }] }; } }),
}));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: { dictationEnabled: boolean }) => unknown) => select(runtime) }));
vi.mock('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => true }));
vi.mock('@/hooks/useDictation', () => ({ useDictation: (options: { onTranscript: (text: string) => void }) => {
  speech.renders(); speech.deliver = options.onTranscript;
  return { status: 'idle', partialTranscript: '', error: null, volume: 0, startDictation: speech.start,
    confirmDictation: speech.confirm, cancelDictation: speech.cancel, discardFailedDictation: () => {} };
} }));
vi.mock('@/components/chat/imageSource', () => ({ useRuntimeTransportIdentity: () => runtime.transport }));
vi.mock('@/queries/sessionIndexQueries', () => ({
  sessionIndexSnapshotQueryOptions: (transport: string) => ({
    queryKey: ['session-index', transport], queryFn: ({ signal }: { signal: AbortSignal }) => runtime.load(transport, signal), staleTime: 0,
  }),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/textarea', () => ({
  Textarea: React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>((props, ref) => (
    <textarea ref={ref} placeholder={props.placeholder} className={props.className} style={props.style} value={props.value} disabled={props.disabled} onInput={props.onChange as React.FormEventHandler<HTMLTextAreaElement>}
      onCopy={props.onCopy} onCut={props.onCut} onKeyDown={props.onKeyDown} onSelect={props.onSelect} onCompositionStart={props.onCompositionStart} onCompositionEnd={props.onCompositionEnd}
      aria-controls={props['aria-controls']} aria-activedescendant={props['aria-activedescendant']} />
  )),
}));

import { AssistantSessionComposer } from './AssistantSessionComposer';
import { materializeSessionMentionTokens, serializeComposerDocument } from '@/composer/document';
import { parseDraftComposerDocument } from '@/sync/input-draft-types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const session = (id: string, title: string, updated: number): SessionIndexSession => ({
  id, title, directory: '/stale-row-path', projectID: 'project', slug: id, version: '1', time: { created: 1, updated },
});
const snapshot = (): SessionIndexSnapshot => ({
  revision: 1,
  sync: { active: false, completed: 2, total: 2, pendingDirectories: [], completedDirectories: [], failedDirectories: [] },
  directories: ['/repo/one', '/repo/two'].map((directory, index) => ({
    directory, cursor: null, hasMore: true, lastSyncedAt: 1, lastFullSyncedAt: 1, lastAccessedAt: 1,
    sessions: [session(`ses_${index}`, 'Shared "title"', 20 - index)],
  })),
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let draft = '';
let mobile = false;
let active = true;
let pending = false;
const submit = vi.fn();
const voiceSend = vi.fn();
const render = () => root.render(<QueryClientProvider client={client}><main><form onSubmit={(event) => { event.preventDefault(); submit(); }}><AssistantSessionComposer
  key={runtime.transport} active={active} pending={pending} layout={mobile ? 'inline' : 'stacked'} value={draft} isMobile={mobile} autoResize={false} placeholder="normal input"
  onChange={(value) => { draft = value; render(); }} onSubmit={submit} onVoiceSend={voiceSend}
/></form></main></QueryClientProvider>);
const input = () => host.querySelector('textarea')!;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
const type = async (value: string, cursor = value.length, inputType = 'insertText') => {
  await act(async () => {
    input().value = value;
    input().setSelectionRange(cursor, cursor);
    input().dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  });
  await flush();
};
const key = async (value: string, options: KeyboardEventInit = {}) => {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })); });
};
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));

beforeEach(async () => {
  remote.enabled = false; remote.catalogReads.mockClear(); remote.summaryReads.mockClear();
  runtime.transport = 'runtime-a'; runtime.dictationEnabled = true; runtime.load.mockReset().mockResolvedValue(snapshot()); submit.mockReset();
  draft = ''; mobile = false; active = true; pending = false;
  voiceSend.mockReset(); speech.renders.mockClear(); speech.start.mockClear(); speech.confirm.mockClear(); speech.cancel.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });

test('session mentions stay on the contact machine and never request remote catalogs, even with connected Hosts', async () => {
  remote.enabled = true;
  for (let index = 0; index < 50; index++) await act(async () => { draft = `typed ${index}`; render(); });
  expect(remote.catalogReads).not.toHaveBeenCalled();
  expect(remote.summaryReads).not.toHaveBeenCalled();
  await type('@Remote');
  expect(rows()).toHaveLength(0);
  await type('@Shared');
  expect(rows()).toHaveLength(2);
  expect(rows().every((row) => !row.textContent?.includes('Host '))).toBe(true);
  await key('Escape');
  const reads = remote.catalogReads.mock.calls.length;
  for (let index = 0; index < 50; index++) await act(async () => { draft = `after close ${index}`; render(); });
  expect(remote.catalogReads).toHaveBeenCalledTimes(reads);
  expect(reads).toBe(0);
  expect(remote.summaryReads).not.toHaveBeenCalled();
});

test('same-machine select → durable draft → canonical → Assistant send retains the owning directory', async () => {
  remote.enabled = true;
  await type('@Shared');
  const row = rows().find((candidate) => candidate.textContent?.includes('/repo/two'))!;
  expect(row).toBeDefined();
  await act(async () => row.click());
  const document = materializeSessionMentionTokens(draft, new Map());
  expect(document.references[0]).toMatchObject({ kind: 'session', sessionId: 'ses_1', directory: '/repo/two' });
  expect(document.references[0]).not.toHaveProperty('target');
  const durable = parseDraftComposerDocument(document.text, JSON.parse(JSON.stringify(document.references)))!;
  expect(durable).toBeDefined();
  const canonical = serializeComposerDocument(durable);
  expect(canonical).toMatchObject({ ok: true, text: draft });
  const { sendAssistantContactMessage } = await import('@/queries/assistantQueries');
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(new URL(request.url).pathname).toBe('/api/yuri/assistants/contact/messages');
    sent.push(await request.json());
    return Response.json({ admitted: true, messageID: 'message', binding: { sessionID: 'hub-contact', directory: '/hub', sessionGeneration: 1 } }, { status: 202 });
  }));
  try {
    submit.mockImplementation(() => sendAssistantContactMessage('contact', 'message', draft));
    await key('Enter');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ messageID: 'message', parts: [{ type: 'text', text: draft }] });
    const delivered = (sent[0].parts as Array<{ text: string }>)[0].text;
    expect(materializeSessionMentionTokens(delivered, new Map()).references[0]).toMatchObject({ sessionId: 'ses_1', directory: '/repo/two' });
    expect(remote.catalogReads).not.toHaveBeenCalled();
    expect(remote.summaryReads).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

test.each([false, true])('sending keeps the input focused and editable without duplicate admission (mobile=%s)', async (isMobile) => {
  mobile = isMobile;
  await type('hello');
  input().focus();
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  host.querySelector('[data-composer-send]')!.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(isMobile);
  if (!isMobile) {
    await key('Enter');
  } else {
    const button = host.querySelector<HTMLButtonElement>('[data-composer-send]')!;
    button.focus();
    await act(async () => button.click());
  }
  expect(submit).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(input());
  await act(async () => { pending = true; draft = ''; render(); });
  expect(input().disabled).toBe(false);
  expect(document.activeElement).toBe(input());
  await type('next message');
  await key('Enter');
  expect(submit).toHaveBeenCalledTimes(1);
  await act(async () => { pending = false; render(); });
  expect(input().value).toBe('next message');
  expect(document.activeElement).toBe(input());
});

test('mobile Enter retains newline ownership instead of submitting', async () => {
  mobile = true;
  await type('hello');
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => input().dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  await type('hello\nnext', 10, 'insertLineBreak');
  expect(draft).toBe('hello\nnext');
});

test('mobile ASR stays idle through 50 edits and delivers into the latest draft without sending', async () => {
  mobile = true;
  await act(async () => render());
  speech.renders.mockClear();
  for (let index = 0; index < 50; index++) {
    await act(async () => { draft = `typed ${index}`; render(); });
  }
  expect(speech.renders).not.toHaveBeenCalled();
  await act(async () => speech.deliver('识别结果'));
  expect(draft).toBe('typed 49 识别结果');
  expect(voiceSend).not.toHaveBeenCalled();
});

test('mobile ASR sends explicit final text, while edit gesture only updates the draft', async () => {
  mobile = true;
  await act(async () => render());
  vi.useFakeTimers();
  try {
    const pointer = (type: string, x: number) => input().dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 200,
    }));
    await act(async () => { pointer('pointerdown', 200); vi.advanceTimersByTime(300); });
    await act(async () => { pointer('pointermove', 100); pointer('pointerup', 100); });
    await act(async () => speech.deliver('先编辑'));
    expect(draft).toBe('先编辑');
    expect(voiceSend).not.toHaveBeenCalled();
    await act(async () => { draft = ''; render(); });
    expect(document.activeElement).toBe(input());
    for (const type of ['pointerdown', 'touchstart', 'contextmenu', 'selectstart']) {
      const event = type === 'pointerdown'
        ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 })
        : new Event(type, { bubbles: true, cancelable: true });
      await act(async () => { input().dispatchEvent(event); vi.advanceTimersByTime(300); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(speech.start).toHaveBeenCalledTimes(1);
    input().blur();
    await act(async () => { pointer('pointerdown', 200); vi.advanceTimersByTime(300); });
    await act(async () => { pointer('pointerup', 200); });
    await act(async () => speech.deliver('直接发送'));
    expect(voiceSend).toHaveBeenCalledExactlyOnceWith('直接发送');
    expect(draft).toBe('直接发送');
  } finally { vi.useRealTimers(); }
});

test('deactivating the contact removes the hold target and ignores late transcripts', async () => {
  mobile = true;
  await act(async () => render());
  expect(host.querySelector('[data-hold-to-talk-empty="true"]')).not.toBeNull();
  await act(async () => { active = false; render(); });
  expect(host.querySelector('[data-hold-to-talk-empty="true"]')).toBeNull();
  await act(async () => speech.deliver('迟到的识别结果'));
  expect(draft).toBe('');
  expect(voiceSend).not.toHaveBeenCalled();
});

test('placeholder follows gestures and the global switch removes ASR and restores normal input', async () => {
  mobile = true;
  await act(async () => render());
  expect(input().placeholder).toBe('normal input');
  vi.useFakeTimers();
  try {
    const pointer = (type: string, x: number) => input().dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 200,
    }));
    await act(async () => { pointer('pointerdown', 200); vi.advanceTimersByTime(300); });
    expect(input().placeholder).toBe('chat.dictation.releaseSend');
    await act(async () => { pointer('pointermove', 100); });
    expect(input().placeholder).toBe('chat.dictation.releaseCancel');
    await act(async () => { pointer('pointermove', 290); });
    expect(input().placeholder).toBe('chat.dictation.releaseEdit');
    await act(async () => { runtime.dictationEnabled = false; render(); });
    expect(input().placeholder).toBe('normal input');
    expect(document.querySelector('.yuri-speech-overlay')).toBeNull();
    expect(host.querySelector('[data-hold-to-talk-empty="true"]')).toBeNull();
    speech.start.mockClear(); speech.renders.mockClear();
    await act(async () => { pointer('pointerdown', 200); vi.advanceTimersByTime(300); });
    expect(speech.start).not.toHaveBeenCalled();
    expect(speech.renders).not.toHaveBeenCalled();
    await act(async () => { runtime.dictationEnabled = true; render(); });
    expect(input().placeholder).toBe('normal input');
  } finally { vi.useRealTimers(); }
});

test('mounts only for @, searches the bounded snapshot once, and shows directory disambiguation', async () => {
  expect(runtime.load).not.toHaveBeenCalled();
  await type('@');
  expect(rows()).toHaveLength(2);
  expect(rows().map((row) => row.textContent)).toEqual(['Shared "title"/repo/one', 'Shared "title"/repo/two']);
  await type('@Shared');
  await type('@missing');
  expect(rows()).toHaveLength(0);
  expect(document.body.textContent).toContain('sessions.sidebar.empty.noMatches.title');
  expect(runtime.load).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

test('stacked composer retains its textarea spacing and separate footer', () => {
  expect(host.querySelector('[data-composer-layout="stacked"]')).not.toBeNull();
  expect(host.querySelector('[data-chat-input-footer]')).not.toBeNull();
  expect(input().classList.contains('min-h-[52px]')).toBe(true);
  expect(input().classList.contains('pt-4')).toBe(true);
  expect(input().classList.contains('pb-2')).toBe(true);
  expect(input().classList.contains('field-sizing-fixed')).toBe(false);
});

test('inline contact centers the compact input and bottom-aligns measured multiline growth', async () => {
  let measuredHeight = 48;
  const heightAtMeasurement: string[] = [];
  const renderInline = (value: string) => root.render(<AssistantSessionComposer
    active={false} layout="inline" isMobile value={value} onChange={() => {}} onSubmit={submit}
    onAddFiles={() => {}} inputStyle={{ maxHeight: '128px', lineHeight: '24px', paddingTop: '12px', paddingBottom: '12px' }}
  />);
  await act(async () => renderInline(''));
  Object.defineProperty(input(), 'scrollHeight', { configurable: true, get: () => {
    heightAtMeasurement.push(input().style.height);
    return measuredHeight;
  } });
  const row = () => host.querySelector('[data-composer-layout="inline"]')!;
  const shell = () => host.querySelector('[data-composer-input-shell]')!;
  const expectCompact = () => {
    expect(input().style.height).toBe('48px');
    expect(row().classList.contains('items-center')).toBe(true);
    expect(shell().classList.contains('items-center')).toBe(true);
  };
  expectCompact();
  expect(input().classList.contains('field-sizing-fixed')).toBe(true);
  expect(input().classList.contains('py-3')).toBe(true);
  expect(input().classList.contains('leading-6')).toBe(true);
  for (const selector of ['[data-composer-inline-attach]', '[data-composer-inline-send]']) {
    const rail = host.querySelector(selector)!;
    expect(rail.classList.contains('h-12')).toBe(true);
    expect(rail.classList.contains('items-center')).toBe(true);
  }
  await act(async () => renderInline('Single line'));
  expectCompact();
  for (const value of ['Soft wrapped text', 'Two\nlines']) {
    measuredHeight = 72;
    await act(async () => renderInline(value));
    expect(input().style.height).toBe('72px');
    expect(row().classList.contains('items-end')).toBe(true);
    expect(shell().classList.contains('items-end')).toBe(true);
  }
  measuredHeight = 160;
  await act(async () => renderInline('Long multiline text'));
  expect(input().style.height).toBe('128px');
  expect(input().style.overflowY).toBe('auto');
  measuredHeight = 48;
  await act(async () => renderInline(''));
  expectCompact();
  expect(input().style.overflowY).toBe('hidden');
  expect(heightAtMeasurement.every((height) => height === '0px')).toBe(true);
});

test.each([0.9, 0.9718333333333333, 1, 1.029, 7 / 6])('inline contact uses scaled single-line metrics at density %s', async (scale) => {
  const compactHeight = 48 * scale;
  let measuredHeight = Math.round(compactHeight);
  const renderInline = (value: string) => root.render(<AssistantSessionComposer
    active={false} layout="inline" isMobile={scale !== 1} value={value} onChange={() => {}} onSubmit={submit}
    inputStyle={{ maxHeight: `${128 * scale}px`, minHeight: `${36 * scale}px`, lineHeight: `${24 * scale}px`, paddingTop: `${12 * scale}px`, paddingBottom: `${12 * scale}px` }}
  />);
  await act(async () => renderInline(''));
  Object.defineProperty(input(), 'scrollHeight', { configurable: true, get: () => measuredHeight });
  const row = () => host.querySelector('[data-composer-layout="inline"]')!;
  for (const value of ['Single line', '']) {
    await act(async () => renderInline(value));
    expect(Number.parseFloat(input().style.height)).toBeCloseTo(Math.max(compactHeight, measuredHeight), 3);
    expect(row().classList.contains('items-center')).toBe(true);
  }
  measuredHeight = Math.round(72 * scale);
  await act(async () => renderInline('Two\nlines'));
  expect(row().classList.contains('items-end')).toBe(true);
  expect(Number.parseFloat(input().style.height)).toBe(measuredHeight);
  measuredHeight = Math.round(compactHeight);
  await act(async () => renderInline(''));
  expect(row().classList.contains('items-center')).toBe(true);
});

test.each([false, true])('inline contact text and reference overlay share mobile-only left inset (mobile=%s)', async (isMobile) => {
  await act(async () => root.render(<AssistantSessionComposer
    active={false} layout="inline" isMobile={isMobile} value="@session:ses_0" onChange={() => {}} onSubmit={submit} autoResize={false}
  />));
  const overlay = host.querySelector('[data-composer-highlight]')!;
  for (const element of [input(), overlay]) {
    expect(element.classList.contains('pl-2')).toBe(isMobile);
    expect(element.classList.contains('px-3')).toBe(true);
    expect(element.classList.contains('py-3')).toBe(true);
  }
});

test('keyboard selection uses the shared chip display and canonical session codec', async () => {
  await type('Watch @Sh please', 9);
  await key('ArrowDown');
  expect(input().getAttribute('aria-activedescendant')).toBe(rows()[1].id);
  await key('Enter');
  expect(draft).toBe('Watch @session:{"sessionID":"ses_1","directory":"/repo/two"} please');
  expect(input().value).toContain('Shared "title"');
  expect(input().value).not.toContain('session:');
  expect(host.querySelector('[data-composer-highlight]')?.textContent).toContain('Shared "title"');
  expect(rows()).toHaveLength(0);
  expect(submit).not.toHaveBeenCalled();
  expect(input().selectionStart).toBe(input().value.indexOf('please'));
  await key('Enter');
  expect(submit).toHaveBeenCalledTimes(1);
});

test('compact picker insets its options and preserves close and selection focus behavior', async () => {
  await type('@');
  const list = document.querySelector('[role="listbox"]')!;
  expect(list.classList.contains('p-1.5')).toBe(true);
  expect(rows()[0].getAttribute('aria-selected')).toBe('true');
  expect(rows()[0].querySelector('[title="/repo/one"]')?.classList.contains('truncate')).toBe(true);
  const close = document.querySelector<HTMLButtonElement>('button[aria-label="dialog.common.actions.close"]')!;
  await act(async () => close.click());
  expect(rows()).toHaveLength(0);
  expect(draft).toBe('@');
  await type('@Sh');
  await key('ArrowUp');
  expect(rows()[1].getAttribute('aria-selected')).toBe('true');
  await key('Enter');
  expect(document.activeElement).toBe(input());
  expect(draft).toBe(' @session:{"sessionID":"ses_1","directory":"/repo/two"} ');
});

test('Tab accepts, Escape and outside press cancel while retaining the draft', async () => {
  await type('@Shared'); await key('Escape');
  expect(draft).toBe('@Shared'); expect(rows()).toHaveLength(0);
  await type('@Share');
  await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
  expect(rows()).toHaveLength(0); expect(draft).toBe('@Share');
  await type('@Shared'); await key('Tab');
  expect(materializeSessionMentionTokens(draft, new Map()).references[0]).toMatchObject({ sessionId: 'ses_0', directory: '/repo/one' }); expect(submit).not.toHaveBeenCalled();
});

test('email, pasted references, and IME confirmation preserve ordinary text ownership', async () => {
  await type('person@example'); expect(rows()).toHaveLength(0);
  await type('@Shared', 7, 'insertFromPaste'); expect(rows()).toHaveLength(0);
  await act(async () => { input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  await type('@Sh'); await key('Enter', { isComposing: true });
  expect(rows()).toHaveLength(0); expect(submit).not.toHaveBeenCalled();
  await key('Enter'); expect(submit).not.toHaveBeenCalled();
  await act(async () => { input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  await flush(); expect(rows()).toHaveLength(2); expect(draft).toBe('@Sh');
});

test('mobile touch scrolling preserves the draft and a tap selects once through the shared portal', async () => {
  mobile = true; await act(async () => render()); await type('@');
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  const pointer = async (target: HTMLElement, type: string, y: number) => act(async () => {
    target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', clientX: 10, clientY: y, bubbles: true, cancelable: true }));
  });
  const row = rows()[0];
  await pointer(row, 'pointerdown', 10); await pointer(row, 'pointermove', 35); await pointer(row, 'pointerup', 35);
  await act(async () => row.click()); expect(draft).toBe('@');
  await pointer(row, 'pointerdown', 10); await pointer(row, 'pointerup', 10);
  expect(draft.match(/@session:/g)).toHaveLength(1); expect(rows()).toHaveLength(0); expect(submit).not.toHaveBeenCalled();
});

test('loading and failed refresh remain distinct from empty success; retry retains cached rows', async () => {
  runtime.load.mockImplementationOnce(() => new Promise(() => {}));
  await type('@'); expect(document.body.textContent).toContain('common.loading');
  await key('Escape');
  client.setQueryData(['session-index', runtime.transport], snapshot());
  runtime.load.mockRejectedValueOnce(new Error('offline'));
  await type('@S');
  expect(rows()).toHaveLength(2);
  expect(document.body.textContent).toContain('assistants.contact.sessionMention.loadFailed');
  expect(document.body.textContent).not.toContain('sessions.sidebar.empty.noMatches.title');
  const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'chat.history.retry')!;
  await act(async () => retry.click()); await flush();
  expect(document.querySelector('[role="alert"]')).toBeNull(); expect(rows()).toHaveLength(2);
});

test('inactive and runtime changes close candidates; late results stay in their captured runtime', async () => {
  let resolve!: (value: SessionIndexSnapshot) => void;
  runtime.load.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await type('@');
  runtime.transport = 'runtime-b'; await act(async () => render());
  await act(async () => resolve(snapshot())); await flush(); expect(rows()).toHaveLength(0);
  runtime.load.mockResolvedValueOnce({ ...snapshot(), directories: [] });
  await type('@S'); expect(rows()).toHaveLength(0);
  expect(runtime.load.mock.calls.at(-1)?.[0]).toBe('runtime-b');
  active = false; await act(async () => render());
  expect(document.querySelector('[role="listbox"]')).toBeNull(); expect(draft).toBe('@S');
});

test('unsupported snapshot is explicitly unavailable and closed autocomplete consumes no requests', async () => {
  runtime.load.mockResolvedValueOnce(null); await type('@');
  expect(document.body.textContent).toContain('common.unavailable');
  await key('Escape'); await act(async () => render());
  expect(runtime.load).toHaveBeenCalledTimes(1);
});

test('large bounded snapshots keep rendered rows capped and ordinary parent renders reuse the query', async () => {
  const data = snapshot();
  data.directories = Array.from({ length: 200 }, (_, directoryIndex) => ({
    ...data.directories[0], directory: `/repo/${directoryIndex}`,
    sessions: Array.from({ length: 20 }, (_, index) => session(`ses_${directoryIndex}_${index}`, `Work ${index}`, index)),
  }));
  data.directories[0].sessions.push({ ...session('ses_archived', 'Archived only', 100), time: { created: 1, updated: 100, archived: 100 } });
  runtime.load.mockResolvedValueOnce(data);
  await type('@'); expect(rows()).toHaveLength(3);
  await type('@Work'); expect(rows()).toHaveLength(10);
  for (let index = 0; index < 20; index += 1) await act(async () => render());
  expect(runtime.load).toHaveBeenCalledTimes(1);
  await type('@Archived'); expect(rows()).toHaveLength(0);
});


test.each([false, true])('contact keeps only send through repeated messages and admission (mobile=%s)', async (isMobile) => {
  mobile = isMobile;
  await type('A follow-up');
  const send = () => host.querySelector<HTMLButtonElement>('[data-composer-send]')!;
  expect(host.querySelector('[data-composer-stop]')).toBeNull();
  expect(send().disabled).toBe(false);
  await act(async () => send().click());
  expect(submit).toHaveBeenCalledTimes(1);
  await act(async () => { pending = true; draft = ''; render(); });
  expect(host.querySelector('[data-composer-stop]')).toBeNull();
  expect(send().disabled).toBe(true);
  expect(input().disabled).toBe(false);
  await type('Another follow-up');
  await act(async () => send().click());
  expect(submit).toHaveBeenCalledTimes(1);
  await act(async () => { pending = false; render(); });
  expect(host.querySelector('[data-composer-stop]')).toBeNull();
  expect(send().disabled).toBe(false);
  await act(async () => send().click());
  expect(submit).toHaveBeenCalledTimes(2);
});


test('shared reference deletion and undo keep canonical identity and surrounding text', async () => {
  await type('Read @Sh please', 8);
  await key('Enter');
  const selected = draft;
  const chipEnd = input().value.indexOf(' please');
  input().setSelectionRange(chipEnd, chipEnd);
  await key('Backspace');
  expect(draft).toBe('Read  please');
  expect(host.querySelector('[data-composer-highlight]')).toBeNull();
  await key('z', { ctrlKey: true });
  expect(draft).toBe(selected);
  expect(host.querySelector('[data-composer-highlight]')?.textContent).toContain('Shared "title"');
  await key('z', { ctrlKey: true, shiftKey: true });
  expect(draft).toBe('Read  please');
});

test('external canonical drafts materialize using the same session codec and reset cleanly', async () => {
  draft = 'Read @session:ses_external'; await act(async () => render());
  expect(input().value).toContain('ses_external');
  expect(input().value).not.toContain('session:');
  expect(host.querySelector('[data-composer-highlight]')).not.toBeNull();
  draft = ''; await act(async () => render());
  expect(input().value).toBe('');
  expect(host.querySelector('[data-composer-highlight]')).toBeNull();
});


test('copy and cut serialize the shared canonical identity instead of a display label', async () => {
  await type('@Sh'); await key('Enter');
  const start = input().value.indexOf('@');
  input().setSelectionRange(start + 1, start + 4);
  const setData = vi.fn();
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData } });
  await act(async () => input().dispatchEvent(copy));
  expect(setData).toHaveBeenLastCalledWith('text/plain', '@session:{"sessionID":"ses_0","directory":"/repo/one"}');
  expect(materializeSessionMentionTokens(draft, new Map()).references[0]).toMatchObject({ sessionId: 'ses_0', directory: '/repo/one' });
  input().setSelectionRange(start + 1, start + 4);
  const cut = new Event('cut', { bubbles: true, cancelable: true });
  Object.defineProperty(cut, 'clipboardData', { value: { setData } });
  await act(async () => input().dispatchEvent(cut));
  expect(draft).not.toContain('@session:');
});
