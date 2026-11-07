import {
  applyComposerSwapCommit, applyComposerSwapForce, applyComposerSwapPin, applyComposerSwapScroll,
  applyComposerSwapSnapDone, COMPOSER_SWAP_INTENT_TRAVEL_PX, COMPOSER_SWAP_INTENT_WINDOW_MS,
  COMPOSER_SWAP_RETURN_ZONE_PX, COMPOSER_SWAP_SNAP_MS, createComposerSwapState, distanceFromBottomOf, resolveNativeComposerDock,
  type ComposerSwapState, type NativeComposerDockRest,
} from '../ui/src/components/chat/mobileComposerSwap';

export type ChatChromeState = Readonly<{ swap: ComposerSwapState; dock: number }>;
export type ChatScrollFrame = { offset: { y: number }; size: { height: number }; contentSize: { height: number } };
export const createChatChromeState = (): ChatChromeState => ({ swap: createComposerSwapState(), dock: 0 });

/** O(1) presentation only. The inverted List remains the only scroll writer. */
export function createNativeChatChrome(publish: (state: ChatChromeState) => void, now = Date.now) {
  let state = createChatChromeState(), frame: ChatScrollFrame | undefined, user = false;
  let previousDistance = 0, intent = 0, intentAt = 0, direction: 'compact' | 'expanded' | null = null;
  let dockRest: NativeComposerDockRest = 'bottom', timer: ReturnType<typeof setTimeout> | undefined;
  function update(swap: ComposerSwapState, dock = state.dock) {
    if (swap === state.swap && dock === state.dock) return;
    state = { swap, dock }; publish(state);
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (swap.phase === 'snapping') timer = setTimeout(() => { timer = undefined; update(applyComposerSwapSnapDone(state.swap)); }, COMPOSER_SWAP_SNAP_MS);
  }
  const distance = (value: ChatScrollFrame) => distanceFromBottomOf({ scrollHeight: value.contentSize.height, scrollTop: value.offset.y, clientHeight: value.size.height });
  function commit() {
    const releaseDirection = now() - intentAt <= COMPOSER_SWAP_INTENT_WINDOW_MS && Math.abs(intent) >= COMPOSER_SWAP_INTENT_TRAVEL_PX
      && !(direction === 'expanded' && previousDistance >= COMPOSER_SWAP_RETURN_ZONE_PX) ? direction : null;
    update(applyComposerSwapCommit(state.swap, releaseDirection));
  }
  return {
    begin(event: { offset: { y: number } }) {
      user = true; intent = 0; direction = null;
      if (frame) previousDistance = distance({ ...frame, offset: event.offset });
    },
    scroll(next: ChatScrollFrame) {
      const nextDistance = distance(next);
      const resized = !frame || next.size.height !== frame.size.height || next.contentSize.height !== frame.contentSize.height;
      frame = next;
      const dock = resolveNativeComposerDock(nextDistance, dockRest); dockRest = dock.rest;
      if (!user || resized) { previousDistance = nextDistance; update(state.swap, dock.progress); return; }
      const delta = nextDistance - previousDistance;
      if (delta !== 0) {
        const nextDirection = delta > 0 ? 'compact' : 'expanded';
        intent = direction === nextDirection ? intent + delta : delta;
        direction = nextDirection; intentAt = now();
      }
      const swap = applyComposerSwapScroll(state.swap, nextDistance, { previousDistance, userDriven: true });
      previousDistance = nextDistance; update(swap, dock.progress);
    },
    release: commit,
    end() { commit(); user = false; },
    pin(pinned: boolean) { if (pinned) { user = false; intent = 0; direction = null; } update(applyComposerSwapPin(state.swap, pinned)); },
    expand() { user = false; intent = 0; direction = null; update(applyComposerSwapForce(state.swap, 'expanded')); },
    reset() { user = false; frame = undefined; dockRest = 'bottom'; update(createComposerSwapState(), 0); },
    dispose() { user = false; if (timer) clearTimeout(timer); timer = undefined; },
  };
}
