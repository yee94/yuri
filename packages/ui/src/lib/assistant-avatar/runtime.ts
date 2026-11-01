import { createAssistantAvatarPlayer, createAssistantAvatarTimeline, mountAssistantAvatarRenderer } from './engine';
import { subscribeAvatarFrames } from './frameClock';
import { acquireAvatarPointer } from './pointerTracker';
import { resolveAssistantAvatar, type AssistantAvatarRecipe, type AvatarMotion, type AvatarEyeColor } from './recipe';

type WorkingTimeline = {
  users: number;
  active: number;
  timeline: ReturnType<typeof createAssistantAvatarTimeline>;
  frame: ReturnType<ReturnType<typeof createAssistantAvatarTimeline>['advance']>;
  timestamp: number;
};
const workingTimelines = new WeakMap<Window, Map<string, WorkingTimeline>>();

function acquireWorkingTimeline(win: Window, identity: string, seed: string, recipe: AssistantAvatarRecipe, compact: boolean) {
  let timelines = workingTimelines.get(win);
  if (!timelines) { timelines = new Map(); workingTimelines.set(win, timelines); }
  const key = JSON.stringify([identity, seed, compact]);
  let shared = timelines.get(key);
  if (!shared) {
    const timeline = createAssistantAvatarTimeline(recipe, seed, 'working', compact);
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
export function mountAvatarAnimation(host: HTMLElement, { id, seed, animationKey = seed ?? 'default', randomizeShape = false, eyeColor }: { id: string; seed?: string; animationKey?: string; randomizeShape?: boolean; eyeColor?: AvatarEyeColor }) {
  const recipe = resolveAssistantAvatar(seed);
  const renderer = mountAssistantAvatarRenderer(host.ownerDocument, id, recipe, eyeColor);
  host.append(renderer.svg);
  let player: ReturnType<typeof createAssistantAvatarPlayer> | null = null;
  let stop: (() => void) | null = null;
  let disposed = false;
  let shared: ReturnType<typeof acquireWorkingTimeline> | null = null;
  let settling = false;
  let settleDeadline = 0;
  let state: { active: boolean; motion: AvatarMotion; size: number; followPointer: boolean } = { active: false, motion: 'idle', size: 0, followPointer: false };
  const resting = () => state.motion === 'idle' && !randomizeShape && !state.followPointer;
  const sharing = () => state.motion === 'working' && !randomizeShape && !state.followPointer;

  const reset = () => {
    if (!stop) return;
    stop(); stop = null; player = null; shared = null; settling = false;
    renderer.still();
  };
  const start = () => {
    if (player) return;
    const win = host.ownerDocument.defaultView;
    if (!win) return;
    const live = createAssistantAvatarPlayer(recipe, seed ?? 'default', state.motion, state.size < 48, { randomizeShape, eyeColor, resting: resting() });
    player = live;
    shared = sharing() ? acquireWorkingTimeline(win, animationKey, seed ?? 'default', recipe, state.size < 48) : null;
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
      const sample = live.advance((timestamp - previous) / 1000, source?.read(timestamp));
      renderer.paint(sample);
      previous = timestamp;
      if (resting() && !sample.hovering && (!settling || timestamp > settleDeadline || (source ? source.settled() : live.isSettled))) reset();
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
    update(next: { active: boolean; motion: AvatarMotion; size: number; followPointer?: boolean }) {
      if (disposed) return;
      const wasResting = resting();
      const wasSharing = sharing();
      const previous = state;
      state = { ...next, active: next.active && recipe.animate, followPointer: next.followPointer ?? false };
      // Leaving live work: ease from the current pose to the static pose, then release.
      if (state.active && player && !wasResting && resting()) {
        settling = true;
        settleDeadline = performance.now() + 1500;
        if (shared) shared.rest(); else player.setResting(true);
        return;
      }
      if (settling && sharing() && shared) {
        settling = false;
        shared.resume();
        player?.setMotion(state.motion);
        return;
      }
      if (!state.active || wasResting !== resting() || wasSharing !== sharing()
        || previous.followPointer !== state.followPointer
        || (wasSharing && (previous.size < 48) !== (state.size < 48))) reset();
      if (!state.active) return;
      if (player) {
        player.setCompact(state.size < 48);
        player.setMotion(state.motion);
      } else if (!resting()) start();
    },
    hover() {
      if (disposed || !state.active) return;
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
