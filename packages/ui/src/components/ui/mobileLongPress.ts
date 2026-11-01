import { LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from '@/lib/touch-gestures/tap';

const MOBILE_LONG_PRESS_DELAY_MS = LONG_PRESS_MS;
const MOBILE_LONG_PRESS_MOVE_THRESHOLD_PX = LONG_PRESS_MOVE_PX;

type TimerHandle = ReturnType<typeof setTimeout>;

type LongPressControllerOptions = {
  delayMs?: number;
  moveThresholdPx?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  clear?: (handle: TimerHandle) => void;
  onPressedKeyChange?: (key: string | null) => void;
};

type ActivePress = {
  pointerId: number;
  key: string;
  startX: number;
  startY: number;
  timer: TimerHandle;
  triggered: boolean;
};

export type MobileLongPressController = {
  start: (args: {
    pointerId: number;
    key: string;
    clientX: number;
    clientY: number;
    onTrigger: () => void;
  }) => void;
  move: (pointerId: number, clientX: number, clientY: number) => void;
  end: (pointerId: number) => void;
  cancel: (pointerId: number) => void;
  openFromContextMenu: (key: string, onTrigger: () => void) => void;
  consumeClick: (key: string) => boolean;
  reset: () => void;
};

export const createMobileLongPressController = (
  options: LongPressControllerOptions = {},
): MobileLongPressController => {
  const delayMs = options.delayMs ?? MOBILE_LONG_PRESS_DELAY_MS;
  const thresholdSquared = (options.moveThresholdPx ?? MOBILE_LONG_PRESS_MOVE_THRESHOLD_PX) ** 2;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const clear = options.clear ?? ((handle) => clearTimeout(handle));
  let active: ActivePress | null = null;
  let suppressedClickKey: string | null = null;

  const clearActive = (preservePressed = false) => {
    if (!active) return;
    clear(active.timer);
    active = null;
    if (!preservePressed) options.onPressedKeyChange?.(null);
  };

  const start: MobileLongPressController['start'] = ({
    pointerId,
    key,
    clientX,
    clientY,
    onTrigger,
  }) => {
    clearActive();
    options.onPressedKeyChange?.(key);
    const timer = schedule(() => {
      if (!active || active.pointerId !== pointerId || active.key !== key) return;
      active.triggered = true;
      suppressedClickKey = key;
      onTrigger();
    }, delayMs);
    active = { pointerId, key, startX: clientX, startY: clientY, timer, triggered: false };
  };

  const cancel = (pointerId: number) => {
    if (active?.pointerId !== pointerId) return;
    clearActive();
  };

  return {
    start,
    move: (pointerId, clientX, clientY) => {
      if (active?.pointerId !== pointerId || active.triggered) return;
      const deltaX = clientX - active.startX;
      const deltaY = clientY - active.startY;
      if (deltaX * deltaX + deltaY * deltaY > thresholdSquared) clearActive();
    },
    end: (pointerId) => {
      if (active?.pointerId !== pointerId) return;
      clearActive(active.triggered);
    },
    cancel,
    openFromContextMenu: (key, onTrigger) => {
      clearActive();
      suppressedClickKey = key;
      options.onPressedKeyChange?.(key);
      onTrigger();
    },
    consumeClick: (key) => {
      if (suppressedClickKey !== key) return false;
      suppressedClickKey = null;
      return true;
    },
    reset: () => {
      clearActive();
      suppressedClickKey = null;
      options.onPressedKeyChange?.(null);
    },
  };
};
