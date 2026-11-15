import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { MobileSwipeActionRail } from './MobileSwipeActionRail';
import { useMobileSwipeActions } from './useMobileSwipeActions';
import { triggerMobileHaptic } from '@/hooks/streamingHaptics';
import { useEvent } from '@reactuses/core';

vi.mock('@/hooks/streamingHaptics', () => ({ triggerMobileHaptic: vi.fn(() => true) }));
vi.mock('@reactuses/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reactuses/core')>();
  return { ...actual, useEvent: vi.fn(actual.useEvent) };
});

function Row({ id, onOpen, onEdit, onDelete, onRead, onFullSwipe }: { id: string; onOpen: () => void; onEdit: () => void; onDelete: () => void; onRead?: () => void; onFullSwipe?: () => void }) {
  const swipe = useMobileSwipeActions(id, onOpen, false, onFullSwipe);
  return <div data-row={id}>
    <MobileSwipeActionRail swipe={swipe} actions={[
      { label: 'Edit', icon: 'edit', onClick: onEdit },
      ...(onRead ? [{ label: 'Read', icon: 'mail-open' as const, onClick: onRead }] : []),
      { label: 'Delete', icon: 'delete-bin', destructive: true, fullSwipe: Boolean(onFullSwipe), onClick: onDelete },
    ]} />
    <button data-main onClick={swipe.handleSelect} onPointerDown={swipe.handlePointerDown}
      onPointerMove={swipe.handlePointerMove} onPointerUp={swipe.finishGesture}
      onPointerCancel={swipe.handlePointerCancel}>{id}</button>
  </div>;
}

test('shared swipe reveals actions, coordinates rows, preserves scrolling and prevents accidental navigation', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const event = (target: Element, type: string, x: number, y = 0, pointerType = 'touch') => act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType, clientX: x, clientY: y }));
  });
  try {
    act(() => root.render(<>{['a', 'b'].map(id => <Row key={id} id={id} onOpen={onOpen} onEdit={onEdit} onDelete={onDelete} />)}</>));
    const rows = [...container.querySelectorAll('[data-row]')];
    const mains = rows.map(row => row.querySelector('[data-main]')!);
    const rails = rows.map(row => row.querySelector('.yuri-mobile-session-actions')!);
    expect((rails[0] as HTMLElement).style.getPropertyValue('--yuri-mobile-session-action-count')).toBe('2');
    rails.forEach(rail => Object.defineProperty(rail, 'offsetWidth', { value: 112 }));
    const swipe = (index: number) => {
      event(mains[index], 'pointerdown', 200);
      event(mains[index], 'pointermove', 100);
      event(mains[index], 'pointerup', 100);
    };
    event(mains[0], 'pointerdown', 200);
    event(mains[0], 'pointermove', 195, 80);
    event(mains[0], 'pointerup', 195, 80);
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
    swipe(0);
    expect(rails[0].getAttribute('aria-hidden')).toBe('false');
    act(() => (mains[0] as HTMLButtonElement).click());
    expect(onOpen).not.toHaveBeenCalled();
    swipe(1);
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
    expect(rails[1].getAttribute('aria-hidden')).toBe('false');
    act(() => (rails[1].querySelector('[aria-label="Edit"]') as HTMLButtonElement).click());
    expect(onEdit).toHaveBeenCalledOnce();
    expect(rails[1].getAttribute('aria-hidden')).toBe('true');
    swipe(0);
    act(() => (rails[0].querySelector('[aria-label="Delete"]') as HTMLButtonElement).click());
    expect(onDelete).toHaveBeenCalledOnce();
    event(mains[0], 'pointerdown', 200);
    event(mains[0], 'pointermove', 100);
    event(mains[0], 'pointercancel', 100);
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
    event(mains[0], 'pointerdown', 200, 0, 'mouse');
    event(mains[0], 'pointermove', 100, 0, 'mouse');
    event(mains[0], 'pointerup', 100, 0, 'mouse');
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test.each([128, 192])('full swipe on a $width rail expands archive, vibrates once, and commits only on release', (width) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const archive = vi.fn();
  const open = vi.fn();
  const pointer = (target: Element, type: string, x: number) => act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch', clientX: x,
    }));
  });
  vi.mocked(triggerMobileHaptic).mockClear();
  try {
    act(() => root.render(<Row id="full" onOpen={open} onEdit={vi.fn()} onDelete={archive} onRead={width === 192 ? vi.fn() : undefined} onFullSwipe={archive} />));
    const rail = host.querySelector<HTMLElement>('.yuri-mobile-session-actions')!;
    const main = host.querySelector<HTMLButtonElement>('[data-main]')!;
    const geometry = vi.fn(() => width);
    Object.defineProperty(rail, 'offsetWidth', { get: geometry });
    Object.defineProperty(rail.parentElement, 'offsetWidth', { value: 390 });
    pointer(main, 'pointerdown', 380);
    pointer(main, 'pointermove', 380 - width);
    pointer(main, 'pointerup', 380 - width);
    expect(archive).not.toHaveBeenCalled();
    expect(triggerMobileHaptic).not.toHaveBeenCalled();
    // Continue from the already revealed rail, including a drag starting on an action.
    const action = rail.querySelector<HTMLButtonElement>('button')!;
    pointer(action, 'pointerdown', 220);
    pointer(action, 'pointermove', 190);
    expect(Number(rail.style.getPropertyValue('--yuri-mobile-full-swipe-progress'))).toBeGreaterThan(0);
    expect(rail.querySelector('.yuri-mobile-session-action-full-swipe')).not.toBeNull();
    pointer(action, 'pointermove', 20);
    for (let i = 0; i < 50; i++) pointer(action, 'pointermove', 20 - i / 10);
    expect(rail.dataset.fullSwipeArmed).toBe('true');
    expect(triggerMobileHaptic).toHaveBeenCalledExactlyOnceWith('medium', { bypassCadence: true });
    expect(geometry).toHaveBeenCalledTimes(2);
    expect(archive).not.toHaveBeenCalled();
    pointer(action, 'pointerup', 20);
    act(() => action.click());
    act(() => main.click());
    expect(archive).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(rail.dataset.revealed).toBe('false');
  } finally {
    act(() => root.unmount());
  }
});

test.each(['reverse', 'cancel', 'busy', 'other-row', 'blur'])('armed archive cancels on %s without dispatching', (mode) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const archive = vi.fn();
  const render = (enabled = true) => act(() => root.render(<Row id="cancel-full" onOpen={vi.fn()} onEdit={vi.fn()} onDelete={archive} onFullSwipe={enabled ? archive : undefined} />));
  const pointer = (target: Element, type: string, x: number) => act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch', clientX: x,
    }));
  });
  try {
    render();
    const rail = host.querySelector<HTMLElement>('.yuri-mobile-session-actions')!;
    const main = host.querySelector('[data-main]')!;
    Object.defineProperty(rail, 'offsetWidth', { value: 192 });
    Object.defineProperty(rail.parentElement, 'offsetWidth', { value: 390 });
    pointer(main, 'pointerdown', 380);
    pointer(main, 'pointermove', 20);
    expect(rail.dataset.fullSwipeArmed).toBe('true');
    if (mode === 'reverse') pointer(main, 'pointermove', 180);
    if (mode === 'cancel') pointer(main, 'pointercancel', 20);
    if (mode === 'busy') render(false);
    if (mode === 'other-row') act(() => window.dispatchEvent(new CustomEvent('yuri:mobile-session-row-revealed', { detail: 'other' })));
    if (mode === 'blur') act(() => window.dispatchEvent(new Event('blur')));
    pointer(main, 'pointerup', 20);
    expect(archive).not.toHaveBeenCalled();
    expect(rail.dataset.fullSwipeArmed).toBeUndefined();
  } finally {
    act(() => root.unmount());
  }
});

test('500 rows keep native swipe handlers free of per-handler effects and listener churn', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const noop = () => undefined;
  const MemoRow = React.memo(Row);
  const rows = Array.from({ length: 500 }, (_, index) => `perf-${index}`);
  const render = () => root.render(<>{rows.map(id => <MemoRow key={id} id={id}
    onOpen={noop} onEdit={noop} onDelete={noop} onFullSwipe={noop} />)}</>);
  const pointer = (target: Element, type: string, x: number) => act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch', clientX: x,
    }));
  });
  const stableCallbacks = vi.mocked(useEvent);
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  try {
    act(render);
    stableCallbacks.mockClear();
    for (let update = 0; update < 50; update++) act(render);
    expect(stableCallbacks).not.toHaveBeenCalled();
    const rail = host.querySelector<HTMLElement>('.yuri-mobile-session-actions')!;
    const main = host.querySelector('[data-main]')!;
    const measure = vi.fn(() => 192);
    Object.defineProperty(rail, 'offsetWidth', { get: measure });
    Object.defineProperty(rail.parentElement, 'offsetWidth', { value: 390 });
    pointer(main, 'pointerdown', 380);
    pointer(main, 'pointermove', 350);
    add.mockClear();
    remove.mockClear();
    stableCallbacks.mockClear();
    for (let move = 0; move < 50; move++) pointer(main, 'pointermove', 345 - move * 5);
    // Only closeActions crosses a stable external/effect boundary; DOM handlers do not.
    expect(stableCallbacks).toHaveBeenCalledTimes(50);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(measure).toHaveBeenCalledOnce();
    pointer(main, 'pointercancel', 100);
    stableCallbacks.mockClear();
    act(() => window.dispatchEvent(new CustomEvent('yuri:mobile-session-row-revealed', { detail: 'other' })));
    expect(stableCallbacks).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    add.mockRestore();
    remove.mockRestore();
  }
});

test('same-batch cancellation resets pending motion and native handlers use the latest archive callback', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const first = vi.fn();
  const latest = vi.fn();
  const noop = () => undefined;
  const render = (archive: () => void) => act(() => root.render(<Row id="fresh" onOpen={noop}
    onEdit={noop} onDelete={archive} onFullSwipe={archive} />));
  const dispatch = (target: Element, type: string, x: number) => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch', clientX: x,
    }));
  };
  try {
    render(first);
    const rail = host.querySelector<HTMLElement>('.yuri-mobile-session-actions')!;
    const main = host.querySelector('[data-main]')!;
    Object.defineProperty(rail, 'offsetWidth', { value: 192 });
    Object.defineProperty(rail.parentElement, 'offsetWidth', { value: 390 });
    act(() => {
      dispatch(main, 'pointerdown', 380);
      dispatch(main, 'pointermove', 20);
      dispatch(main, 'pointercancel', 20);
    });
    expect(rail.dataset.revealed).toBe('false');
    expect(rail.dataset.fullSwipeArmed).toBeUndefined();
    act(() => dispatch(main, 'pointerdown', 380));
    act(() => dispatch(main, 'pointermove', 20));
    render(latest);
    act(() => dispatch(main, 'pointerup', 20));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

test('three-action rail uses the measured full width and closes after the added action', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onRead = vi.fn();
  const onOpen = vi.fn();
  try {
    act(() => root.render(<Row id="three" onOpen={onOpen} onEdit={vi.fn()} onDelete={vi.fn()} onRead={onRead} />));
    const rail = container.querySelector<HTMLElement>('.yuri-mobile-session-actions')!;
    const main = container.querySelector('[data-main]')!;
    Object.defineProperty(rail, 'offsetWidth', { value: 192 });
    expect(rail.style.getPropertyValue('--yuri-mobile-session-action-count')).toBe('3');
    expect(rail.querySelectorAll('button')).toHaveLength(3);
    for (const button of rail.querySelectorAll('button')) {
      expect(button.className).toContain('has-[>svg]:px-1');
    }
    for (const [type, x] of [['pointerdown', 240], ['pointermove', 20], ['pointerup', 20]] as const) {
      act(() => main.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch', clientX: x, clientY: 0,
      })));
    }
    expect(rail.style.transform).toBe('translate3d(calc(100% + -192px), 0, 0)');
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Read"]')!.click());
    expect(onRead).toHaveBeenCalledOnce();
    expect(rail.getAttribute('aria-hidden')).toBe('true');
    expect(rail.classList.contains('invisible')).toBe(false);
    expect(rail.dataset.revealed).toBe('false');
    expect(rail.classList.contains('pointer-events-none')).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

test.each([112, 192].flatMap(width =>
  ['outside', 'blur', 'reverse-row', 'reverse-actions', 'vertical', 'cancel-scroll'].map(mode => ({ width, mode })),
))('open $width px rail dismisses with $mode without accidental actions', ({ width, mode }) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const outside = vi.fn();
  const pointer = (target: Element, type: string, x: number, y = 0) => act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
      pointerType: 'touch', clientX: x, clientY: y,
    }));
  });
  try {
    act(() => root.render(<>
      <Row id="dismiss" onOpen={onOpen} onEdit={onEdit} onDelete={vi.fn()} onRead={width === 192 ? vi.fn() : undefined} />
      <button data-outside onClick={outside}>Outside</button>
    </>));
    const main = container.querySelector('[data-main]')!;
    const rail = container.querySelector<HTMLElement>('.yuri-mobile-session-actions')!;
    Object.defineProperty(rail, 'offsetWidth', { value: width });
    pointer(main, 'pointerdown', 240);
    pointer(main, 'pointermove', 20);
    pointer(main, 'pointerup', 20);
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    if (mode === 'outside') {
      const button = container.querySelector<HTMLButtonElement>('[data-outside]')!;
      pointer(button, 'pointerdown', 200);
      act(() => button.click());
      expect(outside).toHaveBeenCalledOnce();
    } else if (mode === 'blur') {
      act(() => window.dispatchEvent(new Event('blur')));
    } else if (mode === 'cancel-scroll') {
      pointer(main, 'pointerdown', 80);
      pointer(main, 'pointercancel', 80);
    } else {
      const target = mode === 'reverse-actions' ? rail.querySelector('button')! : main;
      pointer(target, 'pointerdown', 80);
      if (mode === 'vertical') {
        pointer(target, 'pointermove', 82, 30);
        pointer(target, 'pointerup', 82, 30);
      } else {
        pointer(target, 'pointermove', 104);
        pointer(target, 'pointerup', 104);
        act(() => (target as HTMLButtonElement).click());
      }
    }
    expect(rail.getAttribute('aria-hidden')).toBe('true');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test('dismissal listeners exist only on the revealed rail and are cleaned on close and unmount', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const pointer = (target: Element, type: string, x: number) => act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
      pointerType: 'touch', clientX: x, clientY: 0,
    }));
  });
  try {
    act(() => root.render(<Row id="listeners" onOpen={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />));
    const main = container.querySelector('[data-main]')!;
    const rail = container.querySelector<HTMLElement>('.yuri-mobile-session-actions')!;
    Object.defineProperty(rail, 'offsetWidth', { value: 112 });
    const open = () => {
      pointer(main, 'pointerdown', 200);
      pointer(main, 'pointermove', 100);
      pointer(main, 'pointermove', 80);
      pointer(main, 'pointerup', 80);
    };
    const count = (spy: typeof add | typeof remove, name: string) => spy.mock.calls.filter(([event]) => event === name).length;
    expect(count(add, 'pointerdown')).toBe(0);
    open();
    expect(count(add, 'pointerdown')).toBe(1);
    expect(count(add, 'wheel')).toBe(1);
    expect(count(add, 'blur')).toBe(1);
    act(() => window.dispatchEvent(new WheelEvent('wheel')));
    expect(rail.getAttribute('aria-hidden')).toBe('true');
    expect(count(remove, 'pointerdown')).toBe(1);
    expect(count(remove, 'wheel')).toBe(1);
    expect(count(remove, 'blur')).toBe(1);
    open();
    act(() => root.unmount());
    expect(count(remove, 'pointerdown')).toBe(2);
    expect(count(remove, 'wheel')).toBe(2);
    expect(count(remove, 'blur')).toBe(2);
  } finally {
    act(() => root.unmount());
    add.mockRestore();
    remove.mockRestore();
    container.remove();
  }
});
