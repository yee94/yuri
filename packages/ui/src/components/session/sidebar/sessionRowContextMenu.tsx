import React from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { useEventListener } from '@reactuses/core';
import { LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from '@/lib/touch-gestures/tap';

/** Virtual element the menu is positioned against: the pointer, not the row box. */
export type ContextMenuAnchor = { getBoundingClientRect: () => DOMRect };

const pointAnchor = (x: number, y: number, size: number): ContextMenuAnchor => ({
  getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: size, height: size }),
});

// Only one finger can be held on one row at a time, so the pending press is shared.
let pendingPress: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;

const cancelPress = (): void => {
  if (pendingPress) clearTimeout(pendingPress.timer);
  pendingPress = null;
};

const ROW_TRIGGER_STYLE: React.CSSProperties = { WebkitTouchCallout: 'none' };

/**
 * Props that make a row open its context menu the way `ContextMenu.Trigger` does: at the
 * pointer on right-click, at the finger after a still long press, with the iOS callout
 * suppressed. The row keeps rendering its own element, so the Base UI menu root can mount
 * only once a menu is requested instead of once per row.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Row trigger props pair with the lazily mounted menu root.
export function sessionRowContextMenuTriggerProps(open: (anchor: ContextMenuAnchor) => void) {
  return {
    style: ROW_TRIGGER_STYLE,
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      open(pointAnchor(event.clientX, event.clientY, 0));
    },
    onTouchStart: (event: React.TouchEvent<HTMLElement>) => {
      if (event.touches.length !== 1) return;
      event.stopPropagation();
      cancelPress();
      const { clientX: x, clientY: y } = event.touches[0];
      pendingPress = {
        x,
        y,
        timer: setTimeout(() => {
          pendingPress = null;
          open(pointAnchor(x, y, 10));
        }, LONG_PRESS_MS),
      };
    },
    onTouchMove: (event: React.TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      if (!pendingPress || event.touches.length !== 1 || !touch) return;
      if (Math.hypot(touch.clientX - pendingPress.x, touch.clientY - pendingPress.y) > LONG_PRESS_MOVE_PX) cancelPress();
    },
    onTouchEnd: cancelPress,
    onTouchCancel: cancelPress,
  };
}

const preventBackdropContextMenu = (event: Event): void => {
  if (event.target instanceof Element && event.target.closest('[data-base-ui-inert]')) event.preventDefault();
};

/**
 * Context menu root without a trigger. `ContextMenu.Trigger` kept the browser menu off the
 * modal backdrop while open; this root takes over that guard for as long as it is mounted.
 */
export function SessionRowContextMenuRoot(props: React.ComponentProps<typeof ContextMenu.Root>): React.ReactNode {
  useEventListener('contextmenu', preventBackdropContextMenu, () => document);
  return <ContextMenu.Root {...props} />;
}
