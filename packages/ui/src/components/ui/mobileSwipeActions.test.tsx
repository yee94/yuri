import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { MobileSwipeActionRail } from './MobileSwipeActionRail';
import { useMobileSwipeActions } from './useMobileSwipeActions';

function Row({ id, onOpen, onEdit, onDelete, onRead }: { id: string; onOpen: () => void; onEdit: () => void; onDelete: () => void; onRead?: () => void }) {
  const swipe = useMobileSwipeActions(id, onOpen);
  return <div data-row={id}>
    <MobileSwipeActionRail swipe={swipe} actions={[
      { label: 'Edit', icon: 'edit', onClick: onEdit },
      ...(onRead ? [{ label: 'Read', icon: 'mail-open' as const, onClick: onRead }] : []),
      { label: 'Delete', icon: 'delete-bin', destructive: true, onClick: onDelete },
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
    expect(onOpen).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
