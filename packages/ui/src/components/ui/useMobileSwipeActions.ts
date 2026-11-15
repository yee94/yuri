import * as React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { triggerMobileHaptic } from '@/hooks/streamingHaptics';

const INTENT_LOCK_PX = 10;
// Keep the homepage event so session and contact rows share one revealed rail.
const REVEALED_ROW_EVENT = 'yuri:mobile-session-row-revealed';
const broadcastRowRevealed = (id: string) => {
  window.dispatchEvent(new CustomEvent(REVEALED_ROW_EVENT, { detail: id }));
};
type ActiveGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  actionWidth: number;
  rowWidth: number;
  fullSwipeThreshold: number;
  offset: number;
  hapticDelivered: boolean;
  fromActionRail: boolean;
  intent: 'pending' | 'horizontal' | 'vertical';
};

/** Homepage left-swipe behavior, shared by sessions and Assistant contacts. */
export function useMobileSwipeActions(id: string, onSelect: () => void, disabled = false, onFullSwipe?: () => void) {
  const [offset, setOffset] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const [fullSwipeProgress, setFullSwipeProgress] = React.useState(0);
  const gestureRef = React.useRef<ActiveGesture | null>(null);
  const suppressClickRef = React.useRef(false);
  const suppressActionClickRef = React.useRef(false);
  const actionRailRef = React.useRef<HTMLDivElement | null>(null);
  const closeActions = useEvent(() => {
    if (!gestureRef.current && offset === 0 && !dragging && fullSwipeProgress === 0) return;
    gestureRef.current = null;
    setOffset(0);
    setDragging(false);
    setFullSwipeProgress(0);
  });
  const fullSwipeEnabled = Boolean(onFullSwipe);
  React.useEffect(() => {
    if (disabled) suppressClickRef.current = true;
    closeActions();
  }, [id, disabled, fullSwipeEnabled, closeActions]);
  useEventListener(REVEALED_ROW_EVENT, (event: Event) => {
    if ((event as CustomEvent<string>).detail !== id) closeActions();
  });
  const dismissalTarget = () => offset !== 0 ? window : null;
  useEventListener('pointerdown', (event: PointerEvent) => {
    const row = actionRailRef.current?.parentElement;
    if (row && !event.composedPath().includes(row)) closeActions();
  }, dismissalTarget, { passive: true });
  useEventListener('wheel', () => closeActions(), dismissalTarget, { passive: true });
  useEventListener('blur', () => closeActions(), dismissalTarget);
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0) return;
    // Swipe reveal is touch/pen only — mouse drag on desktop left residual
    // offsets that painted Pin/Archive over the title.
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const actionWidth = actionRailRef.current?.offsetWidth ?? 0;
    if (actionWidth <= 0) return;
    const rowWidth = Math.max(actionWidth + 96, actionRailRef.current?.parentElement?.offsetWidth ?? 0);
    gestureRef.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      startOffset: offset, actionWidth, intent: 'pending',
      rowWidth, fullSwipeThreshold: actionWidth + Math.max(64, (rowWidth - actionWidth) * 0.55),
      offset, hapticDelivered: false,
      fromActionRail: actionRailRef.current?.contains(event.target as Node) ?? false,
    };
    suppressClickRef.current = false;
    suppressActionClickRef.current = false;
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (disabled) return;
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (gesture.intent === 'pending') {
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (absY > INTENT_LOCK_PX && absY > absX) {
        gesture.intent = 'vertical';
        gestureRef.current = null;
        if (gesture.startOffset !== 0) {
          suppressClickRef.current = true;
          closeActions();
        }
        return;
      }
      if (absX > INTENT_LOCK_PX && absX > absY) {
        gesture.intent = 'horizontal';
        setDragging(true);
        suppressClickRef.current = true;
        suppressActionClickRef.current = gesture.fromActionRail;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Some embedded webviews can report a pointer after capture was
          // already released. The row can still finish from the same target.
        }
        broadcastRowRevealed(id);
      }
    }
    if (gesture.intent !== 'horizontal') return;
    event.preventDefault();
    gesture.offset = Math.max(onFullSwipe ? -gesture.rowWidth : -gesture.actionWidth, Math.min(0, gesture.startOffset + deltaX));
    const progress = onFullSwipe
      ? Math.max(0, Math.min(1, (-gesture.offset - gesture.actionWidth) / (gesture.fullSwipeThreshold - gesture.actionWidth)))
      : 0;
    if (progress === 1 && !gesture.hapticDelivered) {
      triggerMobileHaptic('medium', { bypassCadence: true });
      gesture.hapticDelivered = true;
    }
    setFullSwipeProgress(progress);
    setOffset(gesture.offset);
  };
  const finishGesture = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.intent !== 'horizontal') {
      gestureRef.current = null;
      return;
    }
    if (onFullSwipe && -gesture.offset >= gesture.fullSwipeThreshold) {
      suppressActionClickRef.current = true;
      closeActions();
      onFullSwipe();
      return;
    }
    gestureRef.current = null;
    setDragging(false);
    setFullSwipeProgress(0);
    const closing = gesture.startOffset !== 0 && event.clientX - gesture.startX > INTENT_LOCK_PX;
    setOffset((current) => closing ? 0 : current < -(gesture.actionWidth * 0.35) ? -gesture.actionWidth : 0);
  };
  const handlePointerCancel = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDragging(false);
    setFullSwipeProgress(0);
    setOffset(gesture?.intent === 'horizontal' ? gesture.startOffset : 0);
  };
  const handleActionClickCapture = (event: React.MouseEvent<HTMLElement>) => {
    if (!suppressActionClickRef.current) return;
    suppressActionClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const handleSelect = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (offset !== 0) { closeActions(); return; }
    broadcastRowRevealed(id);
    onSelect();
  };
  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    offset, dragging, fullSwipeProgress, actionRailRef, closeActions, handleSelect,
    handlePointerDown, handlePointerMove, finishGesture, handlePointerCancel, handleContextMenu, handleActionClickCapture,
  };
}
