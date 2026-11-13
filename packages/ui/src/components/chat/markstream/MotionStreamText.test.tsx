import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { MotionStreamText } from './MotionStreamText';
import { MarkstreamHostContext } from './markstreamHostContext';

const state = vi.hoisted(() => ({ reduced: false, animations: [] as { stop: ReturnType<typeof vi.fn>; complete: () => void }[] }));
vi.mock('motion/react', () => ({ useReducedMotion: () => state.reduced }));
vi.mock('motion/mini', () => ({ animate: vi.fn(() => {
  let complete = () => {};
  const stop = vi.fn();
  state.animations.push({ stop, complete: () => complete() });
  return { stop, then(callback: () => void) { complete = callback; } };
}) }));

afterEach(() => { state.reduced = false; state.animations = []; });

function surface() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  return { container,
    render: (content: string, isStreaming = true) => act(async () => {
      root.render(<MarkstreamHostContext.Provider value={{ messageId: 'motion-test', isStreaming, disableStreamAnimation: false, variant: 'assistant', enableFileReferences: false }}>
        <MotionStreamText node={{ type: 'text', content }} />
      </MarkstreamHostContext.Provider>);
    }),
    close: () => act(async () => root.unmount()),
  };
}

test('only the appended suffix animates and the same inline host survives completion', async () => {
  const s = surface();
  try {
    await s.render('Existing text ');
    const host = s.container.firstElementChild;
    expect(state.animations).toHaveLength(0);
    await s.render('Existing text 新增文字与表情👨‍👩‍👧‍👦');
    expect(s.container.textContent).toBe('Existing text 新增文字与表情👨‍👩‍👧‍👦');
    expect(s.container.querySelector('[data-motion-stream-chunk]')?.textContent).toBe('新增文字');
    expect(host?.querySelector('span')?.style.display).toBe('');
    await s.render('Existing text 新增文字与表情👨‍👩‍👧‍👦结束', false);
    expect(s.container.firstElementChild).toBe(host);
    expect(s.container.querySelector('[data-motion-stream-chunk]')).toBeNull();
    expect(s.container.textContent).toBe('Existing text 新增文字与表情👨‍👩‍👧‍👦结束');
    expect(state.animations.every((animation) => animation.stop.mock.calls.length === 1)).toBe(true);
  } finally { await s.close(); }
});

test('bursts and 50 updates have a bounded animation tail and compact on completion', async () => {
  const s = surface();
  try {
    await s.render('History ');
    let text = 'History ';
    for (let index = 0; index < 50; index += 1) {
      text += '新增文字'.repeat(100);
      await s.render(text);
      expect(s.container.querySelectorAll('[data-motion-stream-chunk]').length).toBeLessThanOrEqual(24);
      expect(s.container.textContent).toBe(text);
    }
    for (const animation of state.animations) animation.complete();
    expect(s.container.querySelector('[data-motion-stream-chunk]')).toBeNull();
    expect(s.container.firstChild?.childNodes.length).toBe(1);
  } finally { await s.close(); }
});

test('reduced motion, authoritative replacement and unmount stop pending work', async () => {
  const s = surface();
  try {
    await s.render('a');
    await s.render('abcdef');
    const pending = state.animations[0];
    await s.render('replacement');
    expect(pending.stop).toHaveBeenCalledOnce();
    expect(s.container.textContent).toBe('replacement');
    state.reduced = true;
    const count = state.animations.length;
    await s.render('replacement with no motion');
    expect(state.animations).toHaveLength(count);
    state.reduced = false;
    await s.render('replacement with no motion then live');
  } finally { await s.close(); }
  expect(state.animations.every((animation) => animation.stop.mock.calls.length === 1)).toBe(true);
});
