import { assistantAvatarArtboard, assistantAvatarSvg, createAssistantAvatarPlayer } from '../ui/src/lib/assistant-avatar/engine';
import { resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import type { Model, Point } from '../ui/src/lib/assistant-avatar/vendor/grok-anatomy/player';

type Sample = ReturnType<ReturnType<typeof createAssistantAvatarPlayer>['advance']>;
const number = (value: number) => String(Math.round(value * 100) / 100);
const path = (points: Point[]) => points.length ? `M${points.map(([x, y]) => `${number(x)} ${number(y)}`).join('L')}Z` : '';

/** Serializes only the reference engine's exposed compact working/rest frames.
 * Reject an expanded/future model rather than silently dropping its decoration.
 */
export function workingAvatarModelSvg(model: Model, viewBox: string, fit: string) {
  const start = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="${viewBox}">`;
  if (model.mode === 'sphere') {
    if (model.glow) throw new Error('unsupported_native_working_avatar_model');
    return `${start}<g transform="${fit}"><path d="${model.bodyD}" fill="${model.inkPaint}" fill-rule="evenodd"/>${model.eyesD ? `<path d="${model.eyesD}" fill="${model.spotPaint}"/>` : ''}</g></svg>`;
  }
  if (model.head || model.parts.length || model.zoom !== 1) throw new Error('unsupported_native_working_avatar_model');
  const body = path(model.bodyPts), eyes = model.eyesPts.map(path).join('');
  if (!eyes) return `${start}<g transform="${fit}"><path d="${body}" fill="${model.inkPaint}" fill-rule="evenodd"/></g></svg>`;
  if (model.cutout) return `${start}<defs><mask id="native-avatar-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256"><rect width="256" height="256" fill="white"/><path d="${eyes}" fill="black"/></mask></defs><g transform="${fit}"><path d="${body}" fill="${model.inkPaint}" fill-rule="evenodd" mask="url(#native-avatar-holes)"/></g></svg>`;
  return `${start}<defs><clipPath id="native-avatar-body"><path d="${body}"/></clipPath></defs><g transform="${fit}"><path d="${body}" fill="${model.inkPaint}" fill-rule="evenodd"/><path d="${eyes}" fill="${model.spotPaint}" clip-path="url(#native-avatar-body)"/></g></svg>`;
}

export function createNativeAssistantFrames(seed: string) {
  const recipe = resolveAssistantAvatar(seed), board = assistantAvatarArtboard(recipe);
  // Working always uses compact mode, including 64px pinned faces, exactly as Web.
  const player = createAssistantAvatarPlayer(recipe, seed, 'working', true);
  const serialize = (sample: Sample) => {
    const bounds = sample.bounds;
    const extent = Math.max(Math.abs(bounds.x0 - board.cx), Math.abs(bounds.x1 - board.cx), Math.abs(bounds.y0 - board.cy), Math.abs(bounds.y1 - board.cy));
    const maxScale = board.size / 2 * 0.98 / Math.max(extent, 1e-6);
    const scale = Math.min(Math.min(1, maxScale) * sample.hoverScale, maxScale);
    const fit = `translate(${board.cx} ${board.cy}) scale(${scale}) translate(${-board.cx} ${-board.cy})`;
    return 'data:image/svg+xml,' + encodeURIComponent(workingAvatarModelSvg(sample.model, board.viewBox, fit));
  };
  let still: string | undefined;
  return {
    sample: (dt: number) => serialize(player.advance(dt)),
    setResting: player.setResting,
    settled: () => player.isSettled,
    still: () => still ??= 'data:image/svg+xml,' + encodeURIComponent(assistantAvatarSvg(seed)),
  };
}
