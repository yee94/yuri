import { createAssistantAvatarPlayer, createAssistantAvatarTimeline, mountAssistantAvatarRenderer } from './engine';
import { subscribeAvatarFrames } from './frameClock';
import { acquireAvatarPointer } from './pointerTracker';
import { resolveAssistantAvatar, type AssistantAvatarRecipe, type AvatarMotion, type AvatarEyeColor } from './recipe';
import { mountContactAvatarAnimation } from './contactAnimation';

type WorkingTimeline = {
  users: number;
  active: number;
  timeline: ReturnType<typeof createAssistantAvatarTimeline>;
  frame: ReturnType<ReturnType<typeof createAssistantAvatarTimeline>['advance']>;
  timestamp: number;
};
const workingTimelines = new WeakMap<Window, Map<string, WorkingTimeline>>();

function acquireWorkingTimeline(win: Window, identity: string, seed: string, recipe: AssistantAvatarRecipe) {
  let timelines = workingTimelines.get(win);
  if (!timelines) { timelines = new Map(); workingTimelines.set(win, timelines); }
  const key = JSON.stringify([identity, seed]);
  let shared = timelines.get(key);
  if (!shared) {
    const timeline = createAssistantAvatarTimeline(recipe, seed, 'working', true);
    shared = { users: 0, active: 0, timeline, frame: timeline.advance(0), timestamp: performance.now() };
    timelines.set(key, shared);
  }
  const source = shared;
  source.users++;
  source.active++;
  if (source.active === 1) source.timeline.setResting(false);
  let released = false;
  let working = true;
  return {
    settled: () => source.timeline.isSettled,
    // The shared pose only eases to rest once no sharer is still working.
    rest() {
      if (!working || released) return;
      working = false;
      if (--source.active === 0) source.timeline.setResting(true);
    },
    resume() {
      if (working || released) return;
      working = true;
      if (source.active++ === 0) source.timeline.setResting(false);
    },
    read(timestamp?: number) {
      if (timestamp !== undefined && timestamp !== source.timestamp) {
        source.frame = source.timeline.advance((timestamp - source.timestamp) / 1000);
        source.timestamp = timestamp;
      }
      return source.frame;
    },
    release() {
      if (released) return;
      released = true;
      if (working) source.active--;
      if (--source.users === 0) timelines.delete(key);
      if (!timelines.size) workingTimelines.delete(win);
    },
  };
}

/** One DOM owner. React and non-React callers only supply identity and live state. */
export function mountAvatarAnimation(host: HTMLElement, { id, seed, animationKey, randomizeShape = false, eyeColor }: { id: string; seed?: string; animationKey?: string; randomizeShape?: boolean; eyeColor?: AvatarEyeColor }) {
  if (animationKey && !randomizeShape) return mountContactAvatarAnimation(host, { id, seed, animationKey, eyeColor });
  const recipe = resolveAssistantAvatar(seed);
  const renderer = mountAssistantAvatarRenderer(host.ownerDocument, id, recipe, eyeColor);
  host.append(renderer.svg);
  let player: ReturnType<typeof createAssistantAvatarPlayer> | null = null;
  let stop: (() => void) | null = null;
  let disposed = false;
  let shared: ReturnType<typeof acquireWorkingTimeline> | null = null;
  let settling = false;
  let settleDeadline = 0;
  let appeared = false;
  let onceFinished = false;
  let nextAppearanceBlinkIn: number | null = null;
  let remainingAppearanceBlinks = 0;
  let state: { active: boolean; motion: AvatarMotion; size: number; followPointer: boolean; animateIdle?: boolean; playOnce?: boolean } = { active: false, motion: 'idle', size: 0, followPointer: false };
  const resting = () => state.motion === 'idle' && ((state.playOnce && onceFinished) || (!randomizeShape && !state.followPointer && !state.animateIdle && !state.playOnce));
  const sharing = () => state.motion === 'working' && !randomizeShape;
  // Work uses one clip/geometry mode so slot size cannot change the shared pose.
  const compact = () => sharing() || state.size < 48;

  const reset = () => {
    nextAppearanceBlinkIn = null;
    remainingAppearanceBlinks = 0;
    if (!stop) return;
    if (state.playOnce) onceFinished = true;
    stop(); stop = null; player = null; shared = null; settling = false;
    renderer.still();
  };
  const start = () => {
    if (player) return;
    const win = host.ownerDocument.defaultView;
    if (!win) return;
    const idleEntrance = Boolean(state.motion === 'idle' && (state.animateIdle || state.playOnce) && !(state.playOnce && onceFinished) && !randomizeShape && !state.followPointer);
    const live = createAssistantAvatarPlayer(recipe, seed ?? 'default', state.motion, compact(), { randomizeShape, eyeColor, resting: resting() || idleEntrance, ...(state.playOnce && !onceFinished ? { playOnce: true } : {}) });
    if (idleEntrance) live.setResting(false);
    player = live;
    shared = sharing() ? acquireWorkingTimeline(win, seed ?? 'default', seed ?? 'default', recipe) : null;
    const pointer = state.followPointer ? acquireAvatarPointer(win) : null;
    if (shared) renderer.paint(live.advance(0, shared.read()));
    const source = shared;
    let gaze: [number, number] | null = null;
    let previousGaze: [number, number] | null = null;
    let previous = performance.now();
    const unsubscribe = subscribeAvatarFrames((timestamp) => {
      if (gaze?.[0] !== previousGaze?.[0] || gaze?.[1] !== previousGaze?.[1]) {
        live.setGaze(gaze);
        previousGaze = gaze;
      }
      const dt = Math.min(0.1, Math.max(0, (timestamp - previous) / 1000));
      if (nextAppearanceBlinkIn !== null) {
        nextAppearanceBlinkIn -= dt;
        if (nextAppearanceBlinkIn <= 0) {
          live.blink();
          remainingAppearanceBlinks--;
          nextAppearanceBlinkIn = remainingAppearanceBlinks > 0 ? 0.55 : null;
        }
      }
      const sample = live.advance(dt, source?.read(timestamp));
      if (state.playOnce && !onceFinished && live.finished) {
        onceFinished = true;
        settling = true;
        settleDeadline = timestamp + 1500;
      }
      renderer.paint(sample);
      previous = timestamp;
      if (resting() && nextAppearanceBlinkIn === null && !sample.hovering && !sample.blinking && (!settling || timestamp > settleDeadline || (source ? source.settled() : live.isSettled))) reset();
    }, () => {
      gaze = null;
      const point = pointer?.read();
      if (!point) return;
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // Anatomy's width-based reach, with positive y pointing upwards.
      const reach = rect.width * 2;
      gaze = [
        Math.max(-1, Math.min(1, (point.x - rect.left - rect.width / 2) / reach)),
        Math.max(-1, Math.min(1, -(point.y - rect.top - rect.height / 2) / reach)),
      ];
    });
    stop = () => { unsubscribe(); pointer?.release(); source?.release(); };
  };

  return {
    update(next: { active: boolean; motion: AvatarMotion; size: number; followPointer?: boolean; blinkOnMount?: boolean | 2; animateIdle?: boolean; playOnce?: boolean }) {
      if (disposed) return;
      const wasResting = resting();
      const wasSharing = sharing();
      const previous = state;
      state = { ...next, active: next.active && recipe.animate, followPointer: Boolean(next.followPointer && !next.playOnce && (next.motion !== 'working' || randomizeShape)) };
      // Leaving live work: ease from the current pose to the static pose, then release.
      if (state.active && player && !wasResting && resting()) {
        settling = true;
        settleDeadline = performance.now() + 1500;
        if (shared) shared.rest(); else player.setResting(true);
        return;
      }
      if (state.active && settling && sharing() && shared) {
        settling = false;
        nextAppearanceBlinkIn = null;
        remainingAppearanceBlinks = 0;
        shared.resume();
        if (player) {
          player.clearInteractions();
          player.setCompact(compact());
          player.setMotion(state.motion);
          renderer.paint(player.advance(0, shared.read()));
        }
        return;
      }
      if (!state.active || wasResting !== resting() || wasSharing !== sharing()
        || previous.followPointer !== state.followPointer) reset();
      if (!state.active) return;
      if (player) {
        player.setCompact(compact());
        player.setMotion(state.motion);
      } else if (!resting()) start();
      if (next.blinkOnMount && !appeared) {
        appeared = true;
        if (sharing()) return;
        start();
        remainingAppearanceBlinks = next.blinkOnMount === 2 ? 2 : 1;
        if (state.animateIdle || state.playOnce) {
          // Keep the native .35s rest-to-idle bridge visible with open eyes.
          // An immediate blink hides the turn and makes reopening look like a reset.
          nextAppearanceBlinkIn = 0.4;
        } else {
          player?.blink();
          remainingAppearanceBlinks--;
          nextAppearanceBlinkIn = remainingAppearanceBlinks > 0 ? 0.55 : null;
        }
      }
    },
    hover() {
      if (disposed || !state.active || sharing()) return;
      start();
      player?.hover();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop?.(); stop = null; player = null;
      renderer.svg.remove();
    },
  };
}
