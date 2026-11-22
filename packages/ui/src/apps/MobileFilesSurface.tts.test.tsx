import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { MobileFilesSurface } from './MobileFilesSurface';
import { getSpeechTracking, pauseSpeechFollowing, resumeSpeechFollowing, trackSpeech } from '@/lib/voice/speech-tracking';
import { useConfigStore } from '@/stores/useConfigStore';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  statFile: vi.fn(),
  isPlaying: false,
  listeners: new Set<() => void>(),
  setPlaying(next: boolean) {
    mocks.isPlaying = next;
    for (const listener of mocks.listeners) listener();
  },
  canResume: vi.fn(() => false),
  play: vi.fn(),
  stop: vi.fn(),
  toastError: vi.fn(),
  t: (key: string) => key,
}));

vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ files: { readFile: mocks.readFile, statFile: mocks.statFile } }),
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'mobile-tts-test',
  getRuntimeGeneration: () => 0,
  getRuntimeKey: () => 'mobile-tts-test',
  getRuntimeApiBaseUrl: () => '',
  subscribeRuntimeEndpointChanged: () => () => {},
  isRuntimeEndpointIdentityChange: () => false,
}));
vi.mock('@/lib/runtime-auth', () => ({
  getRuntimeAuthGeneration: () => 0,
  subscribeRuntimeAuthGeneration: () => () => {},
  acquireRuntimeUrlAuthToken: () => () => {},
  refreshRuntimeUrlAuthToken: async () => 'fixture-url-token',
  subscribeRuntimeUrlAuthToken: () => () => {},
}));
vi.mock('@/lib/preview/project-file-preview', () => ({
  resolveProjectFilePreview: async () => ({ src: 'about:blank', expiresAt: Date.now() + 60_000, release: async () => {} }),
}));
vi.mock('@/lib/runtime-file-resource', () => ({ directFileResource: () => ({ url: 'about:blank' }), readRuntimeFile: vi.fn() }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => false }));
vi.mock('@/components/gui-plugins/GuiFileLinkBridge', () => ({
  GuiFileLinkBridge: ({ children }: { children: (view: { preview: React.ReactNode; controls: null }) => React.ReactNode }) =>
    children({ preview: null, controls: null }),
}));
vi.mock('@/components/chat/MarkdownRenderer', async () => {
  const { stripLeadingFrontmatter } = await import('@/lib/markdown/frontmatter');
  return {
    SimpleMarkdownRenderer: ({ content, stripFrontmatter }: { content: string; stripFrontmatter?: boolean }) => {
      const body = stripFrontmatter ? stripLeadingFrontmatter(content) : content;
      return (
        <article data-markdown>
          {body.split(/\n\n+/).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </article>
      );
    },
  };
});
vi.mock('@/components/chat/imageSource', () => ({ useResolvedImageResource: () => ({ source: '', loading: false }) }));
vi.mock('@/components/chat/message/TextSelectionMenu', () => ({ TextSelectionMenu: () => null }));
vi.mock('@/components/views/PierreDiffViewer', () => ({ PIERRE_RUNTIME_BASE_CSS: '' }));
vi.mock('@pierre/diffs/react', () => ({ File: () => null }));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'light' } }, availableThemes: [] }),
}));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: () => {} }));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: () => {} }));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (select: (value: unknown) => unknown) => select({ pendingFileFocusPath: null, setPendingFileFocusPath: () => {} }),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({
  MobileSheetHeaderActions: ({ children }: { children: React.ReactNode }) => <div data-sheet-header-actions>{children}</div>,
}));
vi.mock('@/hooks/useMessageTTS', () => ({
  useMessageTTS: () => {
    const isPlaying = React.useSyncExternalStore(
      (listener) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; },
      () => mocks.isPlaying,
      () => false,
    );
    return {
      isPlaying,
      play: mocks.play,
      stop: mocks.stop,
      canResume: mocks.canResume,
      unlock: async () => {},
    };
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const path = '/workspace/SKILL.md';
const rawMarkdown = `---\nname: demo\ndescription: test\n---\n\n第一段内容。\n\n第二段内容。`;
const strippedBody = '第一段内容。\n\n第二段内容。';

let host: HTMLDivElement;
let root: Root;
let playback: ReturnType<typeof trackSpeech> | undefined;
let previousTTSFlag: boolean;

const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const renderSurface = async (filePath = path, hideFileHeader = true) => {
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <MobileFilesSurface key={filePath} initialFilePath={filePath} directFilePreview hideFileHeader={hideFileHeader} />
    </QueryClientProvider>,
  ));
  await flush();
  await flush();
};

beforeEach(() => {
  previousTTSFlag = useConfigStore.getState().showMessageTTSButtons;
  useConfigStore.setState({ showMessageTTSButtons: true });
  queryClient.clear();
  mocks.isPlaying = false;
  mocks.canResume.mockReset().mockReturnValue(false);
  mocks.play.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset();
  mocks.toastError.mockReset();
  mocks.statFile.mockReset().mockResolvedValue({ path, size: 120, mtimeMs: 1, isBinary: false });
  mocks.readFile.mockReset().mockResolvedValue({ content: rawMarkdown });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  playback?.stop();
  playback = undefined;
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  useConfigStore.setState({ showMessageTTSButtons: previousTTSFlag });
  vi.restoreAllMocks();
});

describe('MobileFilesSurface Markdown read-aloud', () => {
  test('shows read-aloud button in sheet header only when TTS is enabled and file is Markdown', async () => {
    await act(async () => useConfigStore.setState({ showMessageTTSButtons: false }));
    await renderSurface();
    expect(host.querySelector('button[aria-label="filesView.tts.readAloud"]')).toBeNull();

    await act(async () => useConfigStore.setState({ showMessageTTSButtons: true }));
    await renderSurface('/workspace/index.ts');
    expect(host.querySelector('button[aria-label="filesView.tts.readAloud"]')).toBeNull();

    await renderSurface(path);
    const button = host.querySelector<HTMLButtonElement>('[data-sheet-header-actions] button[aria-label="filesView.tts.readAloud"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-pressed')).toBe('false');
  });

  test('plays stripped Markdown with speech target, handles stop, resume/restart menu, and error toast', async () => {
    await renderSurface();
    expect(host.querySelector('[data-markdown]')?.textContent).not.toContain('name: demo');
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="filesView.tts.readAloud"]')!;
    await act(async () => trigger.click());
    expect(mocks.play).toHaveBeenCalledTimes(1);
    const [spokenText, onSettled, options] = mocks.play.mock.calls[0];
    expect(spokenText.trim()).toBe(strippedBody);
    expect(options?.restart).toBe(false);
    expect(options?.target).toBe(host.querySelector('[data-speech-content="true"]'));
    expect(options?.target?.getAttribute('data-speech-identity')).toBe(`file:${path}`);

    // Error callback reports localized recovery hint.
    await act(async () => onSettled?.(new Error('network')));
    expect(mocks.toastError).toHaveBeenCalledWith('chat.messageBody.tts.failed');

    // Active state renders the same green breathing VoiceActivityIcon and stops on click.
    await act(async () => mocks.setPlaying(true));
    const stopButton = host.querySelector<HTMLButtonElement>('button[aria-label="filesView.tts.stopSpeaking"]')!;
    expect(stopButton.getAttribute('aria-pressed')).toBe('true');
    expect(stopButton.querySelector('use')?.getAttribute('href')).toBe('#yuri-volume-up-fill');
    await act(async () => stopButton.click());
    expect(mocks.stop).toHaveBeenCalledTimes(1);

    // Interrupted checkpoint opens anchored Resume / Restart menu with touch hit height.
    mocks.canResume.mockReturnValue(true);
    await act(async () => mocks.setPlaying(false));
    const resumeTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="filesView.tts.readAloud"]')!;
    await act(async () => resumeTrigger.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['chat.messageBody.tts.resume', 'chat.messageBody.tts.restart']);
    expect(items.every((item) => item.classList.contains('min-h-11'))).toBe(true);
    await act(async () => items[0].click());
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(mocks.play.mock.lastCall?.[2]).toMatchObject({ restart: false });

    await act(async () => resumeTrigger.click());
    const restartItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === 'chat.messageBody.tts.restart')!;
    await act(async () => restartItem.click());
    expect(mocks.play).toHaveBeenCalledTimes(3);
    expect(mocks.play.mock.lastCall?.[2]).toMatchObject({ restart: true });
  });

  test('highlights spoken passage, auto-scrolls into reading safe zone, pauses on manual scroll, and toggles follow control', async () => {
    await renderSurface();
    const scroller = host.querySelector<HTMLElement>('[data-speech-content="true"]')!;
    let scrollTop = 0;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object' && typeof options.top === 'number') scrollTop = options.top;
    });
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 390, 300);
    scroller.scrollTo = scrollTo;

    const makeRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = makeRange();
      range.getBoundingClientRect = () => new DOMRect(0, 900 - scrollTop, 300, 40);
      range.getClientRects = () => Object.assign([new DOMRect(16, 900 - scrollTop, 280, 24)], {
        item: (index: number) => (index === 0 ? new DOMRect(16, 900 - scrollTop, 280, 24) : null),
      });
      return range;
    });

    // Trigger speech tracking on the rendered Markdown container.
    await act(async () => {
      playback = trackSpeech(scroller);
      playback.update('第一段内容。', 0);
    });

    // Auto-highlight marker painted without wrapping text.
    expect(getSpeechTracking()?.range?.toString()).toBe('第一段内容');
    expect(scroller.querySelector('.yuri-speech-marker-layer')).not.toBeNull();
    expect(scroller.querySelectorAll('.yuri-speech-marker-stroke')).toHaveLength(1);
    expect(scroller.querySelectorAll('mark')).toHaveLength(0);

    // Auto-scroll landed centered in the 300px viewport (900 - (300 - 40)/2 = 770).
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTop).toBe(770);

    // Follow button appears active and toggles following off/on.
    const followButton = host.querySelector<HTMLButtonElement>('button[aria-label="chat.messageBody.tts.follow"]')!;
    expect(followButton).not.toBeNull();
    expect(followButton.getAttribute('aria-pressed')).toBe('true');
    expect(followButton.classList.contains('yuri-speech-follow-active')).toBe(true);

    // Manual wheel/touch pauses following without stopping highlight.
    await act(async () => { scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })); });
    expect(getSpeechTracking()?.following).toBe(false);
    expect(followButton.getAttribute('aria-pressed')).toBe('false');
    expect(followButton.classList.contains('yuri-speech-follow-active')).toBe(false);

    // Further updates while paused do not move the viewport.
    scrollTop = 100;
    await act(async () => playback!.update('第二段内容。', 1));
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // Clicking the follow button re-enables following and scrolls to the active passage.
    await act(async () => followButton.click());
    expect(getSpeechTracking()?.following).toBe(true);
    expect(followButton.getAttribute('aria-pressed')).toBe('true');
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTop).toBe(770);

    // Stopping speech clears marker paint and hides the follow button.
    await act(async () => {
      pauseSpeechFollowing(scroller);
      resumeSpeechFollowing();
      playback!.stop();
    });
    expect(scroller.querySelector('.yuri-speech-marker-layer')).toBeNull();
    expect(host.querySelector('button[aria-label="chat.messageBody.tts.follow"]')).toBeNull();
  });
});
