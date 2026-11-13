import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import MessageBody from './MessageBody';
import { QueryClient } from '@tanstack/react-query';
import { createQueryTranscriptRepository } from '@/sync/transcript-repository-query-adapter';
import { normalizeSessionProjectionMessage } from '@/sync/session-projection-api';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { projectTurnActivity } from '../lib/turns/projectTurnActivity';
import type { ChatMessageEntry, TurnActivityRecord } from '../lib/turns/types';
import { AutoReadPlaybackContext } from '@/mobile/chat/auto-read-context';
import { ChildStoreManager } from '@/sync/child-store';
import { getSessionShellActivity } from '@/sync/session-shell-activity';

const mocks = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => ({ ok: true })), speak: vi.fn(), canResume: vi.fn(() => false), autoRead: vi.fn() }));
vi.mock('@/hooks/useMessageTTS', () => ({ useMessageTTS: () => ({ isPlaying: false, play: mocks.speak, stop: () => {}, canResume: mocks.canResume }) }));
vi.mock('@/mobile/chat/auto-read-context', async (importOriginal) => ({ ...await importOriginal<typeof import('@/mobile/chat/auto-read-context')>(), useAutoReadRenderedReply: mocks.autoRead }));
vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});
vi.mock('../FileAttachment', () => ({ MessageFilesDisplay: () => null }));
vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
  SimpleMarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({
  WorkerHighlightedCode: ({ code }: { code: string }) => <code data-highlighted>{code}</code>,
}));
vi.mock('./parts/UserTextPart', () => ({ default: ({ part }: { part: { text: string } }) => <p>{part.text}</p> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('user shell results', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.copy.mockClear();
    mocks.speak.mockClear();
    mocks.canResume.mockReset().mockReturnValue(false);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  test.each([
    ['live', false], ['sorted', false], ['live', true], ['sorted', true],
  ] as const)('textless TPS uses disabled-copy footer immediately and retains its footprint (%s, mobile=%s)', async (chatRenderMode, isMobile) => {
    const previousUI = useUIStore.getState();
    useUIStore.setState({ chatRenderMode, showAssistantTps: true });
    const copy = vi.fn();
    const renderFooter = (completed: boolean, hasTextContent = false, disposition: 'active' | 'abnormal' = 'abnormal') => root.render(<MessageBody
      messageId="tool-only" parts={hasTextContent ? [{ id: 'answer', type: 'text', text: 'Final answer.' } as Part] : []}
      isUser={false} isMessageCompleted={completed} messageFinish={hasTextContent ? 'stop' : 'tool-calls'}
      isMobile={isMobile} copiedCode={null} onCopyCode={() => {}} onCopyMessage={copy}
      expandedTools={new Set()} onToggleTool={() => {}} onShowPopup={() => {}}
      streamPhase="completed" allowAnimation={false} hasTextContent={hasTextContent}
      turnGroupingContext={{ turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
        isLatestTurn: false, hasTools: true, hasReasoning: false, isWorking: false, isTurnSettled: disposition !== 'active',
        completionDisposition: disposition, assistantTps: 28.3, durationMs: 1300 }}
    />);
    try {
      await act(async () => renderFooter(false, false, 'active'));
      expect(container.querySelector('[data-message-footer]')).toBeNull();
      await act(async () => renderFooter(false));
      const footer = container.querySelector<HTMLElement>('[data-message-footer]')!;
      const copyButton = footer.querySelector<HTMLButtonElement>('button[aria-label="chat.messageBody.actions.copyMessageAria"]');
      expect(copyButton).not.toBeNull();
      expect(copyButton!.disabled).toBe(true);
      expect(footer.textContent).toContain('28.3 tok/s');
      const footprint = footer.className;
      await act(async () => copyButton!.click());
      expect(copy).not.toHaveBeenCalled();
      for (const hasTextContent of [false, true, false]) {
        await act(async () => renderFooter(true, hasTextContent));
        expect(container.querySelectorAll('[data-message-footer]')).toHaveLength(1);
        expect(container.querySelector('[data-message-footer]')).toBe(footer);
        expect(footer.className).toBe(footprint);
        expect(footer.querySelector('button[aria-label="chat.messageBody.actions.copyMessageAria"]')).toBe(copyButton);
        expect(copyButton!.disabled).toBe(!hasTextContent);
      }
    } finally {
      await act(async () => useUIStore.setState(previousUI));
    }
  });
  test.each(['live', 'sorted'] as const)('footer copy follows the final body, not process text or completion metadata (%s)', async (chatRenderMode) => {
    const previousUI = useUIStore.getState();
    useUIStore.setState({ chatRenderMode, showAssistantTps: true });
    const progress = { id: 'progress', type: 'text', text: 'Let me run a command.' } as Part;
    const tool = { id: 'command', type: 'tool', tool: 'shell', callID: 'command',
      state: { status: 'completed', input: { command: 'pwd' }, output: '/workspace' } } as Part;
    const answer = { id: 'answer', type: 'text', text: 'Final answer.' } as Part;
    const renderFooter = (finalBody: boolean) => root.render(<MessageBody
      messageId="copy-final-body" parts={finalBody ? [answer] : chatRenderMode === 'sorted' ? [] : [progress]}
      sourceParts={finalBody ? [answer] : [progress, tool]}
      isUser={false} isMessageCompleted={!finalBody} messageFinish={finalBody ? 'stop' : 'tool-calls'}
      isMobile={false} copiedCode={null} onCopyCode={() => {}} onCopyMessage={() => {}}
      expandedTools={new Set()} onToggleTool={() => {}} onShowPopup={() => {}}
      streamPhase="completed" allowAnimation={false} hasTextContent={finalBody || chatRenderMode === 'live'}
      turnGroupingContext={{ turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
        isLatestTurn: false, hasTools: !finalBody, hasReasoning: false, isWorking: false, isTurnSettled: true,
        completionDisposition: finalBody ? 'normal' : 'abnormal', assistantTps: 28.3 }}
    />);
    const copyButton = () => container.querySelector<HTMLButtonElement>('[data-message-footer] button[aria-label="chat.messageBody.actions.copyMessageAria"]')!;
    try {
      await act(async () => renderFooter(false));
      expect(copyButton().disabled).toBe(true);
      await act(async () => renderFooter(true));
      expect(copyButton().disabled).toBe(false);
    } finally {
      await act(async () => useUIStore.setState(previousUI));
    }
  });
  test.each([false, true])('an unrelated latest turn never inherits another turn\'s background count (mobile=%s)', async (isMobile) => {
    const children = new ChildStoreManager();
    const activity = getSessionShellActivity(children);
    activity.event('/workspace', { type: 'shell.created', properties: {
      info: { id: 'sh_other_turn', status: 'running', metadata: { sessionID: 'session' } },
    } });
    const context = (globalThis as unknown as {
      __yuri_sync_context__: React.Context<{ childStores: ChildStoreManager } | null>;
    }).__yuri_sync_context__;
    const text = { id: 'answer', type: 'text', text: 'This reply started no background work.' } as Part;
    const work = (shellID: string): TurnActivityRecord => ({
      id: 'shell-call', kind: 'tool', turnId: 'turn', messageId: 'earlier-step', partIndex: 0,
      part: { id: 'shell-call', type: 'tool', sessionID: 'session', messageID: 'earlier-step', callID: 'call', tool: 'shell',
        state: { status: 'completed', input: {}, metadata: { shellID, status: 'running' } } },
    });
    const render = (shellID: string, latest: boolean) => root.render(<context.Provider value={{ childStores: children }}><MessageBody
      sessionId="session" messageId="unrelated-answer" parts={[text]}
      isUser={false} isMessageCompleted messageFinish="stop" isMobile={isMobile}
      copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()} onToggleTool={() => {}} onShowPopup={() => {}}
      streamPhase="completed" allowAnimation={false} hasTextContent
      turnGroupingContext={{ turnId: 'unrelated-turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
        isLatestTurn: latest, hasTools: false, hasReasoning: false, isWorking: false, isTurnSettled: true, activityParts: [work(shellID)] }}
    /></context.Provider>);
    await act(async () => render('sh_finished', true));
    expect(container.querySelector('[data-background-activity]')).toBeNull();
    await act(async () => render('sh_other_turn', false));
    expect(container.querySelector('[data-background-activity]')).not.toBeNull();
    await act(async () => activity.event('/workspace', { type: 'shell.exited', properties: { id: 'sh_other_turn', status: 'exited' } }));
    expect(container.querySelector('[data-background-activity]')).toBeNull();
  });
  test.each([true, false])('offers anchored resume/restart only for interrupted playback (mobile=%s)', async (isMobile) => {
    const previousConfig = useConfigStore.getState();
    useConfigStore.setState({ ttsInputMode: 'final', showMessageTTSButtons: true });
    try {
      await act(async () => root.render(<MessageBody
        sessionId="session" messageId="speech-choice" parts={[{ id: 'answer', type: 'text', text: 'First passage.\n\nSecond passage.' } as Part]}
        isUser={false} isMessageCompleted messageFinish="stop" isMobile={isMobile} hasTouchInput={isMobile}
        copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()} onToggleTool={() => {}} onShowPopup={() => {}}
        streamPhase="completed" allowAnimation={false} hasTextContent
        turnGroupingContext={{ turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
          isLatestTurn: false, hasTools: false, hasReasoning: false, isWorking: false, isTurnSettled: true }}
      />));
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="chat.messageBody.tts.readAloud"]')!;
      expect(trigger).not.toBeNull();
      await act(async () => trigger.click());
      expect(mocks.speak).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      mocks.canResume.mockReturnValue(true);
      await act(async () => trigger.click());
      expect(mocks.speak).toHaveBeenCalledTimes(1);
      const popup = document.querySelector('[role="menu"]')!;
      expect(popup.classList.contains('yuri-popup-surface')).toBe(true);
      const choices = [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(choices.map((item) => item.textContent)).toEqual(['chat.messageBody.tts.resume', 'chat.messageBody.tts.restart']);
      expect(choices.map((item) => item.querySelector('use')?.getAttribute('href'))).toEqual(['#yuri-play', '#yuri-restart']);
      if (isMobile) expect(choices.every((item) => item.classList.contains('min-h-11'))).toBe(true);
      await act(async () => choices[0].click());
      expect(mocks.speak.mock.lastCall?.[2]?.restart).toBe(false);
      expect(mocks.speak.mock.lastCall?.[2]?.target === container.querySelector('[data-message-text-export-root]')).toBe(true);
      await act(async () => trigger.click());
      const restart = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === 'chat.messageBody.tts.restart')!;
      await act(async () => restart.click());
      expect(mocks.speak).toHaveBeenCalledTimes(3);
      expect(mocks.speak.mock.lastCall?.[2]).toMatchObject({ restart: true });
      await act(async () => trigger.click());
      await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(mocks.speak).toHaveBeenCalledTimes(3);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      useConfigStore.setState({ ttsInputMode: previousConfig.ttsInputMode, showMessageTTSButtons: previousConfig.showMessageTTSButtons });
    }
  });
  test.each([
    ['live', true], ['sorted', true], ['live', false], ['sorted', false],
  ] as const)('final-only speech matches the sorted body in %s view (last=%s)', async (mode, last) => {
    const previousConfig = useConfigStore.getState();
    const previousRenderMode = useUIStore.getState().chatRenderMode;
    useConfigStore.setState({ ttsInputMode: 'final', showMessageTTSButtons: true });
    useUIStore.setState({ chatRenderMode: mode });
    const parts = [
      { id: 'progress', type: 'text', text: 'Let me inspect the implementation.' },
      { id: 'thought', type: 'reasoning', text: 'Private reasoning' },
      { id: 'answer', type: 'text', text: '## Done\n\nThe final body has two paragraphs.\n\nBoth must be read.' },
    ] as Part[];
    const message = { info: { id: 'answer-message', role: 'assistant' }, parts } as ChatMessageEntry;
    const projection = projectTurnActivity({ turnId: 'turn', assistantMessages: [message], showTextJustificationActivity: true });
    const inlineParts = parts.filter((part) => !projection.activityParts.some((activity) => activity.part === part));
    try {
      const stopAutoRead = vi.fn();
      await act(async () => root.render(<AutoReadPlaybackContext.Provider value={{ sessionId: 'session', messageId: 'answer-message', stop: stopAutoRead }}><MessageBody
        sessionId="session" messageId="answer-message" parts={mode === 'sorted' ? inlineParts : parts} sourceParts={parts}
        isUser={false} isMessageCompleted messageFinish="stop" messageCreatedAt={10} messageCompletedAt={20}
        isMobile copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()} onToggleTool={() => {}} onShowPopup={() => {}}
        streamPhase="completed" allowAnimation={false} hasTextContent
        turnGroupingContext={{ turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: last,
          isLatestTurn: false, hasTools: false, hasReasoning: true, isWorking: false, isTurnSettled: true }}
      /></AutoReadPlaybackContext.Provider>));
      expect(mocks.autoRead.mock.lastCall?.[0].text).toBe(last ? (inlineParts[0] as { text: string }).text : '');
      expect(mocks.autoRead.mock.lastCall?.[0].text).not.toContain('inspect');
      if (last) {
        const speechButton = container.querySelector<HTMLButtonElement>('button[aria-label="chat.messageBody.tts.stopSpeaking"]');
        expect(speechButton?.getAttribute('aria-pressed')).toBe('true');
        await act(async () => speechButton!.click());
        expect(stopAutoRead).toHaveBeenCalledTimes(1);
      }
    } finally {
      useConfigStore.setState({ ttsInputMode: previousConfig.ttsInputMode, showMessageTTSButtons: previousConfig.showMessageTTSButtons });
      useUIStore.setState({ chatRenderMode: previousRenderMode });
    }
  });
  const render = async (output: string, status = 'completed', shell = true) => {
    const parts = [{ type: 'text', text: shell ? '/shell' : 'Ordinary message',
      ...(shell ? { shellAction: { command: 'pwd', output, status } } : {}),
    } as Part];
    await act(async () => root.render(<MessageBody
      messageId="shell-1" parts={parts} isUser isMessageCompleted={status === 'completed'}
      isMobile={false} copiedCode={null} onCopyCode={() => undefined}
      expandedTools={new Set()} onToggleTool={() => undefined} onShowPopup={() => undefined}
      streamPhase="completed" allowAnimation={false} shouldShowHeader={false}
    />));
  };

  test.each([false, true])('renders running subagent reports as nonterminal cards, not raw tags or cancelled reports (mobile=%s)', async (isMobile) => {
    for (const state of ['running', 'completed', 'error', 'cancelled']) {
      const normalized = normalizeSessionProjectionMessage('parent', {
        id: 'report', type: 'synthetic',
        metadata: { source: 'subagent', childID: 'child', state: 'completed' },
        text: `<subagent sessionID="child" state="${state}">Partial answer</subagent>`,
      })!;
      await act(async () => root.render(<MessageBody
        messageId="report" parts={normalized.parts} isUser isMessageCompleted isMobile={isMobile}
        copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()} onToggleTool={() => {}} onShowPopup={() => {}}
        streamPhase="completed" allowAnimation={false} shouldShowHeader={false}
      />));
      expect(container.textContent).toContain(state === 'running' ? 'chat.usedGroup.running' : `chat.messageBody.subagent.${state}`);
      expect(container.textContent).not.toContain('<subagent');
      if (state === 'running') {
        expect(container.textContent).not.toContain('chat.messageBody.subagent.completed');
        expect(container.textContent).not.toContain('chat.messageBody.subagent.cancelled');
      }
    }
  });

  test('renders raw output immediately and copies its exact whitespace with feedback', async () => {
    const output = '  /workspace\n<script>literal text</script>\n\n';
    await render(output);
    expect(container.querySelector('pre')?.textContent).toBe(output);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('[data-highlighted]')).toHaveLength(1);
    expect(container.querySelector('[data-highlighted]')?.textContent).toBe('pwd');
    expect(container.textContent).not.toMatch(/showOutput|hideOutput|completed/);
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => container.querySelector('button')!.click());
    expect(mocks.copy).toHaveBeenCalledWith(output);
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('chat.messageBody.shellCommand.copied');
  });

  test('keeps running and error feedback visible, including empty output', async () => {
    await render('', 'running');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('chat.assistantStatus.runningCommand');
    expect(container.querySelector('button')).toBeNull();
    await render('permission denied\n', 'error');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('chat.toolPart.error');
    expect(container.querySelector('pre')?.textContent).toBe('permission denied\n');
  });

  test('preserves whitespace-only output and ordinary user text rendering', async () => {
    await render(' \n');
    expect(container.querySelector('pre')?.textContent).toBe(' \n');
    await render('', 'completed', false);
    expect(container.textContent).toContain('Ordinary message');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain('chat.messageBody.shellCommand.title');
  });

  test.each([true, false])('renders assistant details and error recovery without crashing (mobile=%s)', async (isMobile) => {
    const renderAssistant = async (failed: boolean) => {
      await act(async () => root.render(<MessageBody
        messageId="assistant-1" parts={[]} isUser={false} isMessageCompleted={false}
        isMobile={isMobile} copiedCode={null} onCopyCode={() => undefined}
        expandedTools={new Set()} onToggleTool={() => undefined} onShowPopup={() => undefined}
        streamPhase="streaming" allowAnimation={false} shouldShowHeader={false}
        errorPresentation={failed ? { text: 'Provider unavailable', icon: 'error-warning', variant: 'error' } : undefined}
      />));
    };
    await renderAssistant(false);
    expect(container.querySelector('[data-message-text-export-root]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await renderAssistant(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Provider unavailable');
    await renderAssistant(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-message-text-export-root]')).not.toBeNull();
  });

  test.each(['live', 'sorted'] as const)('shows a completed reply on first entry when initial GET fills a background metadata shell (%s)', async (mode) => {
    const previousMode = useUIStore.getState().chatRenderMode;
    useUIStore.setState({ chatRenderMode: mode });
    const client = new QueryClient();
    const repository = createQueryTranscriptRepository({ client });
    const scope = { directory: '/workspace', sessionID: 'session-completed' };
    const shell = normalizeSessionProjectionMessage(scope.sessionID, {
      id: 'assistant-completed', type: 'assistant', time: { created: 1 }, content: [],
      model: { id: 'model', providerID: 'provider' }, agent: 'build',
    })!;
    const complete = normalizeSessionProjectionMessage(scope.sessionID, {
      id: 'assistant-completed', type: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop',
      content: [{ type: 'text', text: 'The completed answer' }],
      model: { id: 'model', providerID: 'provider' }, agent: 'build',
    })!;
    const subscribe = (notify: () => void) => repository.subscribe(scope, notify);
    const getSnapshot = () => repository.getTranscript(scope);
    function CompletedReply() {
      const transcript = React.useSyncExternalStore(subscribe, getSnapshot);
      const info = transcript.messagesByID[shell.info.id]!;
      const parts = transcript.partsByMessageID[shell.info.id] ?? [];
      return <MessageBody
        messageId={info.id} parts={[...parts]} isUser={false} isMessageCompleted={Boolean(info.time.completed)}
        messageFinish={info.finish}
        isMobile copiedCode={null} onCopyCode={() => undefined}
        expandedTools={new Set()} onToggleTool={() => undefined} onShowPopup={() => undefined}
        streamPhase="completed" allowAnimation={false} shouldShowHeader={false}
      />;
    }
    try {
      repository.apply(scope, { type: 'http-page', purpose: 'initial', page: { records: [shell], complete: true, turnCount: 0 } });
      await act(async () => root.render(<CompletedReply />));
      expect(container.textContent).not.toContain('The completed answer');
      await act(async () => {
        repository.apply(scope, { type: 'http-page', purpose: 'initial', page: { records: [complete], complete: true, turnCount: 0 } });
      });
      const info = repository.getMessage(scope, shell.info.id)!;
      const parts = repository.getParts(scope, shell.info.id);
      expect(info.finish).toBe('stop');
      expect(parts).toHaveLength(1);
      expect(container.textContent).toContain('The completed answer');
    } finally {
      await act(async () => root.render(null));
      repository.destroy();
      client.clear();
      useUIStore.setState({ chatRenderMode: previousMode });
    }
  });
});
