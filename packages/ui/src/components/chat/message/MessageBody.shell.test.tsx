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
import type { ChatMessageEntry } from '../lib/turns/types';
import { AutoReadPlaybackContext } from '@/mobile/chat/auto-read-context';

const mocks = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => ({ ok: true })), speak: vi.fn(), canResume: vi.fn(() => false), autoRead: vi.fn() }));
vi.mock('@/hooks/useMessageTTS', () => ({ useMessageTTS: () => ({ isPlaying: false, play: mocks.speak, stop: () => {}, canResume: mocks.canResume }) }));
vi.mock('@/mobile/chat/auto-read-context', async (importOriginal) => ({ ...await importOriginal<typeof import('@/mobile/chat/auto-read-context')>(), useAutoReadRenderedReply: mocks.autoRead }));
vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});
vi.mock('../FileAttachment', () => ({ MessageFilesDisplay: () => null }));
vi.mock('../MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
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
