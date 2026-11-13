import { createAssistantAvatarPlayer, mountAssistantAvatarRenderer } from './engine';
import { subscribeAvatarFrames } from './frameClock';
import { acquireAvatarPointer } from './pointerTracker';
import { resolveAssistantAvatar, type AvatarEyeColor, type AvatarMotion } from './recipe';

type State = { active: boolean; motion: AvatarMotion; size: number; followPointer?: boolean; blinkOnMount?: boolean | 2; animateIdle?: boolean; playOnce?: boolean };
type Slot = { host: HTMLElement; renderer: ReturnType<typeof mountAssistantAvatarRenderer>; state: State };
type Sample = ReturnType<ReturnType<typeof createAssistantAvatarPlayer>['advance']>;
const groups = new WeakMap<Window, Map<string, ReturnType<typeof createContactAnimation>>>();

function createContactAnimation(win: Window, seed: string, eyeColor?: AvatarEyeColor) {
  const recipe = resolveAssistantAvatar(seed);
  const slots = new Set<Slot>();
  let player: ReturnType<typeof createAssistantAvatarPlayer> | null = null;
  let sample: Sample | null = null;
  let stop: (() => void) | null = null;
  let pointer: ReturnType<typeof acquireAvatarPointer> | null = null;
  let anchor: Slot | undefined;
  let motion: AvatarMotion = 'idle';
  let resting = true;
  let appeared = false;
  let onceFinished = false;
  let playingOnce = false;
  let nextBlinkIn: number | null = null;
  let remainingBlinks = 0;
  let previous = 0;
  let settleDeadline = 0;
  let gaze: [number, number] | null = null;
  let previousGaze: [number, number] | null = null;

  const paint = () => slots.forEach(slot => {
    if (slot.state.active) {
      if (sample) slot.renderer.paint(sample); else slot.renderer.still();
    }
  });
  const reset = () => {
    stop?.(); stop = null;
    pointer?.release(); pointer = null;
    player = null; sample = null; nextBlinkIn = null; remainingBlinks = 0;
    gaze = previousGaze = null;
    paint();
  };
  const start = () => {
    if (player) return;
    const idleEntrance = motion === 'idle';
    // One compact player owns geometry AND interactions for every slot size.
    playingOnce = [...slots].some(slot => slot.state.active && slot.state.playOnce);
    player = createAssistantAvatarPlayer(recipe, seed, motion, true, { eyeColor, resting: idleEntrance, playOnce: playingOnce });
    player.setResting(resting);
    sample = player.advance(0);
    previous = performance.now();
    settleDeadline = previous + 1500;
    stop = subscribeAvatarFrames(timestamp => {
      if (!player) return;
      const dt = Math.min(0.1, Math.max(0, (timestamp - previous) / 1000));
      if (gaze?.[0] !== previousGaze?.[0] || gaze?.[1] !== previousGaze?.[1]) {
        player.setGaze(gaze); previousGaze = gaze;
      }
      if (nextBlinkIn !== null && (nextBlinkIn -= dt) <= 0) {
        player.blink();
        nextBlinkIn = --remainingBlinks > 0 ? 0.55 : null;
      }
      sample = player.advance(dt);
      previous = timestamp;
      paint();
      if (player.finished && !onceFinished) {
        onceFinished = true;
        reconcile();
      }
      if (resting && nextBlinkIn === null && !sample.hovering && !sample.blinking && (player.isSettled || timestamp > settleDeadline)) reset();
    }, () => {
      gaze = null;
      const point = pointer?.read();
      if (!point || !anchor) return;
      const rect = anchor.host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const reach = rect.width * 2;
      gaze = [
        Math.max(-1, Math.min(1, (point.x - rect.left - rect.width / 2) / reach)),
        Math.max(-1, Math.min(1, -(point.y - rect.top - rect.height / 2) / reach)),
      ];
    });
    paint();
  };
  function reconcile() {
    const active = [...slots].filter(slot => slot.state.active);
    if (!active.length) {
      if (player && playingOnce) onceFinished = true;
      reset();
      return;
    }
    const nextMotion = active.find(slot => slot.state.motion === 'working')?.state.motion
      ?? active.find(slot => slot.state.motion !== 'idle')?.state.motion ?? 'idle';
    const nextAnchor = nextMotion === 'idle' ? active.find(slot => slot.state.followPointer && !slot.state.playOnce) : undefined;
    const nextResting = nextMotion === 'idle' && !nextAnchor && !active.some(slot => slot.state.animateIdle || (slot.state.playOnce && !onceFinished));
    const changed = motion !== nextMotion || resting !== nextResting;
    motion = nextMotion; resting = nextResting; anchor = nextAnchor;
    if (anchor && !pointer) pointer = acquireAvatarPointer(win);
    if (!anchor && pointer) { pointer.release(); pointer = null; gaze = null; }
    if (player && changed) {
      if (motion === 'working') {
        player.clearInteractions(); nextBlinkIn = null; remainingBlinks = 0;
      }
      player.setMotion(motion);
      player.setResting(resting);
      settleDeadline = performance.now() + 1500;
      sample = player.advance(0);
      paint();
    }
    if (!resting) start();
    if (!appeared) {
      appeared = true;
      const greeting = active.find(slot => slot.state.blinkOnMount)?.state.blinkOnMount;
      if (greeting && motion === 'idle') {
        start();
        remainingBlinks = greeting === 2 ? 2 : 1;
        if (active.some(slot => slot.state.animateIdle || slot.state.playOnce)) nextBlinkIn = 0.4;
        else {
          player?.blink();
          nextBlinkIn = --remainingBlinks > 0 ? 0.55 : null;
        }
      }
    }
  }
  return {
    slots,
    add(slot: Slot) {
      slots.add(slot);
      if (sample) slot.renderer.paint(sample);
    },
    update(slot: Slot, state: State) {
      const wasActive = slot.state.active;
      const next = { ...state, active: state.active && recipe.animate };
      const previousState = slot.state;
      if (next.active === previousState.active && next.motion === previousState.motion && next.size === previousState.size
        && next.followPointer === previousState.followPointer && next.blinkOnMount === previousState.blinkOnMount
        && next.animateIdle === previousState.animateIdle && next.playOnce === previousState.playOnce) return;
      slot.state = next;
      reconcile();
      if (slot.state.active) {
        if (sample) slot.renderer.paint(sample); else slot.renderer.still();
      }
      if (wasActive && !slot.state.active) slot.renderer.still();
    },
    hover(slot: Slot) {
      if (!slot.state.active || motion === 'working') return;
      start(); player?.hover();
    },
    remove(slot: Slot) { slots.delete(slot); reconcile(); },
  };
}

/** Contact slots share one player, including idle interactions and transition frames. */
export function mountContactAvatarAnimation(host: HTMLElement, { id, seed = 'default', animationKey, eyeColor }: { id: string; seed?: string; animationKey: string; eyeColor?: AvatarEyeColor }) {
  const renderer = mountAssistantAvatarRenderer(host.ownerDocument, id, resolveAssistantAvatar(seed), eyeColor);
  host.append(renderer.svg);
  const slot: Slot = { host, renderer, state: { active: false, motion: 'idle', size: 0 } };
  const win = host.ownerDocument.defaultView;
  let catalog = win ? groups.get(win) : undefined;
  if (win && !catalog) { catalog = new Map(); groups.set(win, catalog); }
  const key = JSON.stringify([animationKey, seed, eyeColor]);
  let group = catalog?.get(key);
  if (!group && win) { group = createContactAnimation(win, seed, eyeColor); catalog!.set(key, group); }
  group?.add(slot);
  let disposed = false;
  return {
    update(state: State) { if (!disposed) group?.update(slot, state); },
    hover() { if (!disposed) group?.hover(slot); },
    dispose() {
      if (disposed) return;
      disposed = true;
      group?.remove(slot);
      if (!group?.slots.size) {
        catalog?.delete(key);
        if (win && !catalog?.size) groups.delete(win);
      }
      renderer.svg.remove();
    },
  };
}
