import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const api = vi.hoisted(() => ({ generateSessionAside: vi.fn(), renderMarkdown: vi.fn() }));
const language = vi.hoisted(() => ({ locale: 'en', listeners: new Set<() => void>() }));
const speech = vi.hoisted(() => ({ play: vi.fn(async () => {}), stop: vi.fn(), canResume: vi.fn(() => false), evaluations: 0 }));
vi.mock('@/hooks/useMessageTTS', () => ({ useMessageTTS: () => {
  speech.evaluations++;
  return { isPlaying: false, play: speech.play, stop: speech.stop, canResume: speech.canResume };
} }));
vi.mock('@/lib/opencode/client', () => ({
  opencodeClient: {
    generateSessionAside: api.generateSessionAside,
    setDirectory: vi.fn(),
    applySendSelection: vi.fn(async () => {}),
  },
}));
vi.mock('@/components/chat/MarkdownRenderer', () => {
  const render = (props: { content: string; messageId?: string; isStreaming?: boolean }) => {
    api.renderMarkdown(props);
    return <div data-markdown data-message-id={props.messageId}>{props.content}</div>;
  };
  return {
    MarkdownRenderer: (props: Parameters<typeof render>[0]) => render(props),
    SimpleMarkdownRenderer: ({ content }: { content: string }) => render({ content }),
  };
});
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/components/ui/ModelLogo', () => ({ ModelLogo: () => <span data-model-logo /> }));
vi.mock('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      getSessionModelSelection: () => null,
      getSessionAgentSelection: () => null,
      saveSessionModelSelection: vi.fn(),
      saveSessionAgentSelection: vi.fn(),
    }),
  },
}));
vi.mock('@/stores/useConfigStore', () => {
  const configState = {
    providers: [],
    getVisibleAgents: () => [],
    activeDirectoryKey: 'default',
    providerConfigLoadingByDirectory: {} as Record<string, boolean>,
    agentConfigLoadingByDirectory: {} as Record<string, boolean>,
    currentProviderId: 'provider-a',
    currentModelId: 'model-a',
    currentAgentName: undefined as string | undefined,
    currentVariant: null as string | null,
    showMessageTTSButtons: true,
    voiceProvider: 'browser',
  };
  const useConfigStore = ((selector?: (state: typeof configState) => unknown) =>
    (selector ? selector(configState) : configState)) as {
    (selector: (state: typeof configState) => unknown): unknown;
    getState: () => typeof configState;
  };
  useConfigStore.getState = () => configState;
  return { useConfigStore };
});
vi.mock('@/lib/i18n', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/i18n')>();
  const { dict } = await import('@/lib/i18n/messages/en');
  const { dict: chinese } = await import('@/lib/i18n/messages/zh-CN');
  return { ...original, useI18n: () => {
    const locale = React.useSyncExternalStore((listener) => {
      language.listeners.add(listener);
      return () => { language.listeners.delete(listener); };
    }, () => language.locale);
    return { t: (key: keyof typeof dict) => (locale === 'zh-CN' ? chinese : dict)[key], locale };
  } };
});

import { BtwComposerSurface, BtwPanel } from './BtwPanel';
import { useUIStore } from '@/stores/useUIStore';
import { getSessionBtwKey, resetSessionBtwStoreForRuntimeSwitch, useSessionBtwStore } from '@/stores/useSessionBtwStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import { formatAbsoluteMessageTimestamp } from '@/components/chat/message/timeFormat';
import { PRIMARY_SESSION_SURFACE, SessionSurfaceContext } from '@/components/chat/SessionSurfaceContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = { sessionId: 'session-a', directory: '/repo' };
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  speech.evaluations = 0;
  speech.canResume.mockReturnValue(false);
  language.locale = 'en';
  resetSessionBtwStoreForRuntimeSwitch();
  useUIStore.setState({ contextPanelByDirectory: {}, isMobile: true });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ finished: Promise.resolve(), cancel: () => {} }) });
  api.generateSessionAside.mockImplementation(() => new Promise(() => {}));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetSessionBtwStoreForRuntimeSwitch();
  document.body.innerHTML = '';
});

const button = (label: string) => Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.includes(label) || node.getAttribute('aria-label') === label);
const turnsOf = (target = scope) => useSessionBtwStore.getState().entries[getSessionBtwKey(target)]?.turns ?? [];
const typeAndEnter = async (text: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-btw-composer] textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
};

describe('Btw side conversation panel', () => {
  test.each(['panel', 'page'] as const)('shares footer actions, receipt metadata and time interaction on %s', async (foot) => {
    const completedAt = Date.UTC(2026, 10, 3, 10, 30);
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Speak this answer', error: null, pending: false,
        completedAt, durationMs: 1250 }] },
    } });
    const openSourceSession = vi.fn();
    await act(async () => root.render(<SessionSurfaceContext.Provider value={{ ...PRIMARY_SESSION_SURFACE,
      sessionId: scope.sessionId, directory: '/repo', openSourceSession }}><BtwPanel scope={scope} foot={foot} /></SessionSurfaceContext.Provider>));
    const footer = host.querySelector<HTMLElement>('[data-message-footer]')!;
    expect(footer.style.containerName).toBe('message-footer');
    expect(footer.className).toContain(foot === 'page' ? 'mt-3' : 'mt-1.5');
    expect(footer.textContent).toContain('1.3s');
    expect(footer.querySelector('[data-message-time]')?.textContent).toBe(formatAbsoluteMessageTimestamp(completedAt));
    expect(footer.querySelector('use[href="#yuri-pulse"]')).toBeNull();
    expect(footer.querySelector('[aria-label*="Fork"]')).toBeNull();
    expect(footer.querySelector('[aria-label*="source session"]')).toBeNull();
    const copy = button('Copy message text')!;
    expect(copy.className).toContain('size-6!');
    await act(async () => copy.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith('Speak this answer');
    expect(copy.querySelector('use')?.getAttribute('href')).toBe('#yuri-check');
    await act(async () => button('Read aloud')!.click());
    expect(speech.play).toHaveBeenCalledWith('Speak this answer', expect.any(Function), expect.objectContaining({
      target: host.querySelector('[data-message-text-export-root]'), restart: false,
    }));
    const reply = host.querySelector<HTMLElement>('[data-message-text-export-root]')!;
    if (foot === 'page') {
      expect(footer.querySelector('[data-message-time]')?.getAttribute('data-message-time-visible')).toBe('false');
      await act(async () => {
        reply.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch' }));
        reply.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch' }));
      });
      expect(footer.querySelector('[data-message-time]')?.getAttribute('data-message-time-visible')).toBe('true');
    } else {
      expect(footer.querySelector('[data-message-time]')?.className).toContain('yuri-message-hover-time');
      await act(async () => reply.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })));
      expect(reply.hasAttribute('data-message-hovered')).toBe(true);
    }
  });

  test('missing metrics stay absent and copy failure never shows success feedback', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Legacy answer', error: null, pending: false }] },
    } });
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce({ ok: false, error: 'clipboard unavailable' });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(host.querySelector('[data-message-time]')).toBeNull();
    expect(host.querySelector('use[href="#yuri-hourglass"]')).toBeNull();
    await act(async () => button('Copy message text')!.click());
    expect(button('Copy message text')!.querySelector('use')?.getAttribute('href')).toBe('#yuri-file-copy');
  });

  test('an interrupted reading uses the shared resume/restart menu', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Read again', error: null, pending: false }] },
    } });
    speech.canResume.mockReturnValue(true);
    await act(async () => root.render(<BtwPanel scope={scope} />));
    await act(async () => button('Read aloud')!.click());
    expect(speech.play).not.toHaveBeenCalled();
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(['Resume playback', 'Restart playback']);
    await act(async () => items[1]!.click());
    expect(speech.play).toHaveBeenCalledWith('Read again', expect.any(Function), expect.objectContaining({ restart: true }));
  });

  test('the production ContextPanel boundary retains answer DOM and drafts across tab and rail switches', async () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), 'ContextPanel.tsx');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isJsxExpression(node) && node.expression?.getText(source).startsWith('tabs.filter(')
        && node.expression.getText(source).includes('<BtwPanel')) expression = node.expression;
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(expression, 'BTW must have a retained tab boundary, not activeNonChatContent').toBeDefined();
    const output = ts.transpileModule(`return (${expression!.getText(source)});`, {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const renderTabs = new Function('React', 'BtwPanel', 'tabs', 'activeTab', 'previewVisible', 'directoryKey', 'btwSessionId', 't', output) as (
      react: typeof React, panel: typeof BtwPanel, tabs: { id: string; mode: string }[],
      activeTab: { id: string }, visible: boolean, directory: string, sessionId: string, t: (key: string) => string,
    ) => React.ReactNode;
    const tabs = [{ id: 'btw-tab', mode: 'btw' }, { id: 'file-tab', mode: 'file' }];
    const render = async (tab: string, visible = true, sessionId = scope.sessionId, mountedTabs = tabs) => {
      await act(async () => root.render(<>{renderTabs(React, BtwPanel, mountedTabs, { id: tab }, visible, '/repo', sessionId, (key) => key)}</>));
    };
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Settled code', error: null, pending: false }] },
    } });
    await render('btw-tab');
    const answer = host.querySelector('[data-markdown]');
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Unsent draft');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (let index = 0; index < 3; index++) {
      await render('file-tab');
      await render('btw-tab');
      await render('btw-tab', false);
      await render('btw-tab');
      expect(host.querySelector('[data-markdown]')).toBe(answer);
      expect(host.querySelector('textarea')).toBe(textarea);
      expect(textarea.value).toBe('Unsent draft');
    }
    await render('btw-tab', true, 'session-b');
    expect(host.querySelector('[data-markdown]')).toBeNull();
    expect(host.querySelector('textarea')).not.toBe(textarea);
    await render('file-tab', true, 'session-b', [tabs[1]!]);
    expect(host.querySelector('textarea')).toBeNull();
  });

  test('answers use the session rich renderer with a stable turn identity', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: '```jsonc\n{}\n```', error: null, pending: false }] },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(api.renderMarkdown).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: expect.stringContaining('t1'),
      isStreaming: false,
      variant: 'assistant',
      enableFileReferences: false,
    }));
  });

  test('answer arrival does not drag a reader back to the bottom', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Earlier answer', error: null, pending: false }] },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    const scroller = host.querySelector<HTMLDivElement>('[data-btw-transcript]')!;
    let top = 100;
    const writes = vi.fn((value: number) => { top = value; });
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, get: () => top, set: writes },
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    await act(async () => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })));
    writes.mockClear();
    await act(async () => useSessionBtwStore.setState((state) => ({ entries: {
      ...state.entries,
      [getSessionBtwKey(scope)]: { quotes: [], turns: [...state.entries[getSessionBtwKey(scope)]!.turns,
        { id: 't2', quotes: [], question: 'Next?', answer: 'New answer', error: null, pending: false }] },
    } })));
    expect(writes).not.toHaveBeenCalled();
    expect(top).toBe(100);
  });

  test('50 parent and staged-quote updates do not rerender settled answers', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Settled code', error: null, pending: false }] },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    const answer = host.querySelector('[data-markdown]');
    api.renderMarkdown.mockClear();
    const speechEvaluations = speech.evaluations;
    for (let index = 0; index < 50; index++) {
      await act(async () => {
        useSessionBtwStore.getState().addQuote(scope, `quote ${index}`);
        root.render(<BtwPanel scope={{ ...scope }} />);
      });
    }
    expect(api.renderMarkdown).not.toHaveBeenCalled();
    expect(speech.evaluations).toBe(speechEvaluations);
    expect(host.querySelector('[data-markdown]')).toBe(answer);
    api.generateSessionAside.mockResolvedValueOnce({ text: 'Next answer' });
    await typeAndEnter('Next?');
    expect(api.renderMarkdown.mock.calls.filter(([props]) => props.content === 'Settled code')).toHaveLength(1);
    expect(host.querySelector('[data-markdown]')).toBe(answer);
  });

  test('focuses after opening settles and does not steal focus on subsequent updates', async () => {
    const frames: FrameRequestCallback[] = [];
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const trigger = document.createElement('button');
    document.body.append(trigger);
    try {
      await act(async () => root.render(<BtwPanel scope={scope} />));
      trigger.focus();
      await act(async () => { frames.splice(0).forEach((callback) => callback(0)); });
      expect(document.activeElement).toBe(host.querySelector('[data-btw-composer] textarea'));
      trigger.focus();
      await act(async () => useSessionBtwStore.getState().addQuote(scope, 'quote'));
      await act(async () => { frames.splice(0).forEach((callback) => callback(0)); });
      expect(document.activeElement).toBe(trigger);
    } finally {
      request.mockRestore();
    }
  });

  test('opens as an empty mini chat without requesting or loading anything', async () => {
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(host.textContent).toContain('Ask about the conversation while keeping its history unchanged.');
    expect(host.querySelector('[data-btw-composer] textarea')).toBeTruthy();
    expect(api.generateSessionAside).not.toHaveBeenCalled();
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('phone foot follows the primary composer and owns the safe area', async () => {
    await act(async () => root.render(<BtwPanel scope={scope} foot="page" />));
    const form = host.querySelector<HTMLElement>('[data-btw-composer]');
    expect(form?.getAttribute('data-btw-composer-foot')).toBe('page');
    expect(form?.className).toContain('yuri-mobile-composer');
    expect(form?.className).toContain('bottom-safe-area');
    expect(host.querySelector('[data-btw-composer] .yuri-mobile-composer-surface')).toBeTruthy();
  });

  test('sheet foot follows the primary composer without a second safe pad', async () => {
    await act(async () => root.render(<BtwPanel scope={scope} foot="sheet" />));
    const form = host.querySelector<HTMLElement>('[data-btw-composer]');
    expect(form?.className).toContain('yuri-mobile-composer');
    expect(form?.className).not.toContain('bottom-safe-area');
  });

  test('reuses the primary composer pill: stacked textarea, footer send, 1.5rem radius', async () => {
    await act(async () => root.render(<BtwPanel scope={scope} />));
    const surface = host.querySelector<HTMLElement>('[data-btw-composer] > div');
    const textarea = host.querySelector<HTMLTextAreaElement>('[data-btw-composer] textarea');
    const footer = host.querySelector<HTMLElement>('[data-btw-composer] [data-chat-input-footer]');
    const send = host.querySelector<HTMLElement>('[data-btw-composer] [data-composer-send]');
    expect(surface?.style.borderRadius).toBe('1.5rem');
    expect(textarea?.closest('[data-composer-layout="stacked"], [data-composer-content]')).toBeTruthy();
    expect(host.querySelector('[data-composer-layout="inline"]')).toBeNull();
    expect(footer).toBeTruthy();
    expect(footer?.contains(send)).toBe(true);
    expect(textarea?.parentElement?.contains(send)).toBe(false);
  });

  test('Enter in the panel composer sends; follow-ups append as a conversation', async () => {
    api.generateSessionAside.mockResolvedValueOnce({ text: 'First answer' }).mockResolvedValueOnce({ text: 'Second answer' });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    await typeAndEnter('Why?');
    await typeAndEnter('And then?');
    expect(api.generateSessionAside).toHaveBeenCalledTimes(2);
    expect(api.generateSessionAside.mock.calls[1][0].prompt).toContain('User: Why?\n\nAssistant: First answer');
    expect(Array.from(host.querySelectorAll('[data-markdown]')).map((node) => node.textContent)).toEqual(['First answer', 'Second answer']);
    expect(document.querySelector<HTMLTextAreaElement>('[data-btw-composer] textarea')!.value).toBe('');
  });

  test('staged selection quotes render as removable chips and ride along with the next question', async () => {
    useSessionBtwStore.getState().addQuote(scope, 'keep this');
    useSessionBtwStore.getState().addQuote(scope, 'drop this');
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(Array.from(host.querySelectorAll('[data-composer-quote-chip]')).map((node) => node.textContent)).toEqual(['keep this', 'drop this']);
    const removeButtons = host.querySelectorAll<HTMLButtonElement>('[data-composer-quote-chip] button[aria-label="Remove quote"]');
    await act(async () => removeButtons[1]!.click());
    expect(host.querySelectorAll('[data-composer-quote-chip]')).toHaveLength(1);
    expect(api.generateSessionAside).not.toHaveBeenCalled();
    await typeAndEnter('Explain');
    expect(api.generateSessionAside.mock.calls[0][0].prompt).toContain('> keep this\n\nExplain');
    expect(api.generateSessionAside.mock.calls[0][0].prompt).not.toContain('drop this');
    expect(host.querySelectorAll('[data-btw-composer] [data-composer-quote-chip]')).toHaveLength(0);
  });

  test('localizes internal failures and retries the last turn through the same scope', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: '', error: 'empty response', pending: false }] },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Answer generation failed. Please retry.');
    await act(async () => {
      language.locale = 'zh-CN';
      language.listeners.forEach((listener) => listener());
    });
    await act(async () => root.render(<BtwPanel scope={{ ...scope }} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('生成回答失败，请重试。');
    await act(async () => button('重试')!.click());
    expect(api.generateSessionAside).toHaveBeenCalledWith(expect.objectContaining(scope));
  });

  test('copies an answer and hides other sessions’ turns', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Long answer', error: null, pending: false }] },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    await act(async () => button('Copy message text')!.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith('Long answer');
    await act(async () => root.render(<BtwPanel scope={{ ...scope, sessionId: 'session-b' }} />));
    expect(host.textContent).not.toContain('Why?');
  });

  test('tab switching keeps the conversation; closing the btw tab clears it and leaves no composer chip', async () => {
    useUIStore.setState({ isMobile: false });
    await act(async () => root.render(<BtwComposerSurface scope={scope} active mobile={false} />));
    await act(async () => {
      void useSessionBtwStore.getState().ask(scope, 'Why?');
      useUIStore.getState().openContextPanelTab('/repo', { mode: 'btw' });
    });
    const tab = useUIStore.getState().contextPanelByDirectory['/repo'].tabs[0];
    await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'context' }));
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(false);
    expect(turnsOf()).toHaveLength(1);
    await act(async () => useUIStore.getState().closeContextPanelTab('/repo', tab.id));
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(true);
    expect(useSessionBtwStore.getState().entries).toEqual({});
    expect(host.querySelector('button')).toBeNull();
  });

  test('closing the mobile sheet closes the panel and clears the conversation', async () => {
    await act(async () => root.render(<BtwComposerSurface scope={scope} active mobile />));
    await act(async () => {
      void useSessionBtwStore.getState().ask(scope, 'Why?');
      useUIStore.getState().openContextPanelTab('/repo', { mode: 'btw' });
    });
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Why?');
    await act(async () => button('Close')!.click());
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(false);
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(true);
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('StrictMode keeps an accepted request; leaving its session cancels only that request', async () => {
    void useSessionBtwStore.getState().ask(scope, 'First?');
    await act(async () => root.render(<React.StrictMode><BtwComposerSurface scope={scope} active mobile={false} /></React.StrictMode>));
    const firstSignal = api.generateSessionAside.mock.calls[0][0].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    const nextScope = { ...scope, sessionId: 'session-b' };
    void useSessionBtwStore.getState().ask(nextScope, 'Second?');
    await act(async () => root.render(<React.StrictMode><BtwComposerSurface scope={nextScope} active mobile={false} /></React.StrictMode>));
    expect(firstSignal.aborted).toBe(true);
    expect(api.generateSessionAside.mock.calls[1][0].signal.aborted).toBe(false);
    await act(async () => root.render(<div />));
    expect(api.generateSessionAside.mock.calls[1][0].signal.aborted).toBe(true);
  });
});
