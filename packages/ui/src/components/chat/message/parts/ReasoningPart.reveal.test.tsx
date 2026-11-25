import React, { act } from 'react';
import { afterEach, describe, expect, test, vi, type Mock } from 'vitest';
import type { ContentChangeHandler } from '@/hooks/useChatAutoFollow';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { ReasoningTimelineBlock } from './ReasoningPart';

const TEXT = 'First thought about the task.\nSecond line with more detail.';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(onContentChange: Mock<ContentChangeHandler>, defaultExpanded?: boolean) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider>
      <ReasoningTimelineBlock text={TEXT} variant="thinking" blockId="r1" onContentChange={onContentChange} defaultExpanded={defaultExpanded} />
    </I18nProvider>,
  ));
  return { host, animate, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe('ReasoningTimelineBlock panel motion', () => {
  test('expanding lays out at full height at once and animates paint only, then requests one reveal', async () => {
    const onContentChange = vi.fn<ContentChangeHandler>();
    const { host, animate, cleanup } = await mount(onContentChange);
    try {
      const toggle = host.querySelector('[role=button]') as HTMLElement;
      await act(async () => toggle.click());
      const content = host.querySelector('#' + CSS.escape(toggle.getAttribute('aria-controls')!)) as HTMLElement;
      expect(content.style.height).toBe('auto');
      expect(animate).toHaveBeenCalledTimes(1);
      const [keyframes] = animate.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
      expect(keyframes.every((frame) => !('height' in frame))).toBe(true);
      expect(keyframes.map((frame) => frame.opacity)).toEqual([0, 1]);
      expect(onContentChange).toHaveBeenCalledWith('reveal', { revealElement: content });
      expect(onContentChange.mock.calls.filter(([reason]) => reason === 'animation')).toEqual([]);
    } finally { await cleanup(); }
  });

  test('collapsing commits the final layout at once without animation', async () => {
    const onContentChange = vi.fn<ContentChangeHandler>();
    const { host, animate, cleanup } = await mount(onContentChange, true);
    try {
      expect(animate).not.toHaveBeenCalled();
      const toggle = host.querySelector('[role=button]') as HTMLElement;
      await act(async () => toggle.click());
      const content = host.querySelector('#' + CSS.escape(toggle.getAttribute('aria-controls')!)) as HTMLElement;
      expect(content.style.height).toBe('0px');
      expect(animate).not.toHaveBeenCalled();
      expect(onContentChange.mock.calls.some(([reason]) => reason === 'reveal')).toBe(false);
    } finally { await cleanup(); }
  });

  test('a block that mounts already open stays static (virtualizer recycle)', async () => {
    const onContentChange = vi.fn<ContentChangeHandler>();
    const { animate, cleanup } = await mount(onContentChange, true);
    try {
      expect(animate).not.toHaveBeenCalled();
      expect(onContentChange.mock.calls.some(([reason]) => reason === 'reveal')).toBe(false);
    } finally { await cleanup(); }
  });
});
