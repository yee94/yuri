import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { WorkingPlaceholder } from './WorkingPlaceholder';

const motionState = vi.hoisted(() => ({ reducedMotion: true }));
const animations: {
  finish: () => void;
  stop: ReturnType<typeof vi.fn>;
  element: HTMLElement;
  target: { opacity: number };
}[] = [];

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => motionState.reducedMotion,
}));

vi.mock('motion/mini', () => ({
  animate: vi.fn((element: HTMLElement, target: { opacity: number }) => {
    let onFinish = () => {};
    const controls = {
      stop: vi.fn(),
      then: (callback: () => void) => { onFinish = callback; },
      finish: () => onFinish(),
      element,
      target,
    };
    animations.push(controls);
    return controls;
  }),
}));

vi.mock('./MorphOrb', () => ({
  MorphOrb: () => React.createElement('span', { 'data-testid': 'orb' }),
}));

describe('WorkingPlaceholder status stickiness', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    motionState.reducedMotion = true;
    animations.length = 0;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const render = async (
    props: Omit<React.ComponentProps<typeof WorkingPlaceholder>, 'isMobile'>,
  ) => {
    await act(async () => {
      root.render(React.createElement(WorkingPlaceholder, { isMobile: false, ...props }));
    });
  };

  const text = () => container.textContent ?? '';

  test.each([false, true])('mobile status uses the tool-row icon gap (retry=%s)', async (retry) => {
    await act(async () => {
      root.render(React.createElement(WorkingPlaceholder, {
        isMobile: true,
        isWorking: true,
        statusText: 'Running command',
        retryInfo: retry ? { attempt: 1 } : undefined,
      }));
    });

    const iconSlot = container.querySelector('[data-testid="orb"]')?.parentElement;
    expect(iconSlot?.classList.contains('w-4')).toBe(true);
    expect(iconSlot?.parentElement?.classList.contains('gap-1.5')).toBe(true);
    expect(iconSlot?.parentElement?.classList.contains('gap-1')).toBe(false);
  });

  test('specific → generic does not switch within 1200ms (queued)', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await render({
      isWorking: true,
      statusText: 'Working…',
      isGenericStatus: true,
    });
    expect(text()).toContain('Running command');
    expect(text()).not.toContain('Working…');

    await act(async () => {
      vi.advanceTimersByTime(1199);
    });
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(text()).toContain('Working…');
  });

  test('generic → generic churn is ignored', async () => {
    await render({
      isWorking: true,
      statusText: 'Thinking…',
      isGenericStatus: true,
    });
    expect(text()).toContain('Thinking…');

    await render({
      isWorking: true,
      statusText: 'Working…',
      isGenericStatus: true,
    });
    expect(text()).toContain('Thinking…');
    expect(text()).not.toContain('Working…');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(text()).toContain('Thinking…');
  });

  test('specific → specific switches immediately', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    await render({
      isWorking: true,
      statusText: 'Editing file',
      isGenericStatus: false,
    });
    expect(text()).toContain('Editing file');
  });

  test('fades out then in on the same text node and coalesces rapid updates', async () => {
    motionState.reducedMotion = false;
    await render({ isWorking: true, statusText: 'Running command' });
    const label = container.querySelector('.animate-text-shimmer');
    const orb = container.querySelector('[data-testid="orb"]');
    expect(animations).toHaveLength(0);

    await render({ isWorking: true, statusText: 'Thinking' });
    await render({ isWorking: true, statusText: 'Reading file' });
    expect(animations).toHaveLength(1);
    expect(label?.textContent).toBe('Running command');
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Reading file');

    await act(async () => animations[0].finish());
    expect(label?.textContent).toBe('Reading file');
    expect(animations).toHaveLength(2);
    expect(container.querySelector('.animate-text-shimmer')).toBe(label);
    expect(container.querySelector('[data-testid="orb"]')).toBe(orb);
    expect(animations[0].element).toBe(label?.parentElement);
    expect(animations[0].target).toEqual({ opacity: 0 });
    expect(animations[1].element).toBe(label?.parentElement);
    expect(animations[1].target).toEqual({ opacity: 1 });
    expect(label?.classList.contains('flex-1')).toBe(false);
    expect(label?.parentElement?.classList.contains('gap-1.5')).toBe(true);

    for (let index = 0; index < 50; index += 1) {
      await render({ isWorking: true, statusText: 'Reading file', turnStartedAt: Date.now() - index * 1000 });
    }
    expect(animations).toHaveLength(2);
    expect(container.querySelector('.animate-text-shimmer')).toBe(label);
    const timer = container.querySelector('.tabular-nums');
    expect(timer?.parentElement).toBe(label?.parentElement);
    expect(timer?.previousElementSibling).toBe(label);
  });

  test('reduced motion cancels an in-flight fade and stale completion cannot restore old text', async () => {
    motionState.reducedMotion = false;
    await render({ isWorking: true, statusText: 'Running command' });
    await render({ isWorking: true, statusText: 'Thinking' });
    motionState.reducedMotion = true;
    await render({ isWorking: true, statusText: 'Reading file' });
    expect(animations[0].stop).toHaveBeenCalledOnce();
    await act(async () => animations[0].finish());
    expect(container.querySelector('.animate-text-shimmer')?.textContent).toBe('Reading file');
    expect(animations).toHaveLength(1);
  });

  test('elapsed minutes and seconds have a thin space and tabular digits', async () => {
    await render({ isWorking: true, statusText: 'Thinking', turnStartedAt: Date.now() - 65_000 });
    expect(container.querySelector('.tabular-nums')?.textContent).toBe('1m\u20095s');
  });

  test('settling during fade cancels animation without delayed text or fade-in', async () => {
    motionState.reducedMotion = false;
    await render({ isWorking: true, statusText: 'Running command' });
    await render({ isWorking: true, statusText: 'Thinking' });
    await render({ isWorking: true, statusText: 'Thinking', isTurnSettled: true });
    expect(animations[0].stop).toHaveBeenCalledOnce();
    await act(async () => animations[0].finish());
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(animations).toHaveLength(1);
  });

  test('isWorking false then true within 600ms keeps the status text', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await render({
      isWorking: false,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    // Linger: still visible during the clear delay.
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(text()).toContain('Running command');
  });

  test('isWorking false for more than 600ms clears the status', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });

    await render({
      isWorking: false,
      statusText: null,
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(text()).not.toContain('Running command');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('isTurnSettled clears the status immediately without the 600ms linger', async () => {
    await render({
      isWorking: true,
      statusText: 'Thinking',
      isGenericStatus: false,
    });
    expect(text()).toContain('Thinking');

    await render({
      isWorking: false,
      statusText: null,
      isGenericStatus: false,
      isTurnSettled: true,
    });
    expect(text()).not.toContain('Thinking');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('isTurnSettled hides the hint even while isWorking is still true', async () => {
    await render({
      isWorking: true,
      statusText: 'Composing',
      isGenericStatus: false,
    });
    expect(text()).toContain('Composing');

    await render({
      isWorking: true,
      statusText: 'Composing',
      isGenericStatus: false,
      isTurnSettled: true,
    });
    expect(text()).not.toContain('Composing');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
