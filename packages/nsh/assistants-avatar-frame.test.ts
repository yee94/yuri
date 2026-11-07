import { Window } from 'happy-dom';
import { expect, it } from 'vitest';
import { assistantAvatarArtboard, assistantAvatarSvg, createAssistantAvatarPlayer, mountAssistantAvatarRenderer } from '../ui/src/lib/assistant-avatar/engine';
import { AVATAR_SHAPES, encodeAssistantAvatar, resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import { createNativeAssistantFrames, workingAvatarModelSvg } from './assistants-avatar-frame';

it.each(AVATAR_SHAPES)('native working %s uses the exact reference paths, pigments, cutouts and whole-scene fit', shape => {
  const window = new Window(), document = window.document as unknown as Document;
  for (const color of ['mint', 'graphite'] as const) {
    const recipe = { ...resolveAssistantAvatar('native-test'), shape, color };
    const seed = encodeAssistantAvatar(recipe), board = assistantAvatarArtboard(recipe);
    const native = createNativeAssistantFrames(seed), player = createAssistantAvatarPlayer(recipe, seed, 'working', true);
    const reference = mountAssistantAvatarRenderer(document, 'reference', recipe);
    for (const dt of [0, 1 / 30, 0.1, 0.1]) {
      const sample = player.advance(dt); reference.paint(sample);
      const container = document.createElement('div'); container.innerHTML = decodeURIComponent(native.sample(dt).split(',').slice(1).join(','));
      const actual = container.querySelector('svg')!;
      expect(actual.getAttribute('viewBox')).toBe(board.viewBox);
      expect(actual.lastElementChild!.getAttribute('transform')).toBe(reference.svg.lastElementChild!.getAttribute('transform'));
      const body = reference.svg.querySelectorAll('path[fill-rule="evenodd"]')[1];
      expect(actual.querySelector(`path[fill="${sample.model.inkPaint}"][fill-rule="evenodd"]`)?.getAttribute('d')).toBe(body.getAttribute('d'));
      if (sample.model.mode === 'morph' && sample.model.cutout) {
        expect(actual.querySelector('mask path')?.getAttribute('d')).toBe(reference.svg.querySelector('mask path')?.getAttribute('d'));
      } else {
        const referenceEye = [...reference.svg.querySelectorAll('path')].find(path => path.getAttribute('fill') === sample.model.spotPaint && !!path.getAttribute('d'));
        expect(actual.querySelector(`path[fill="${sample.model.spotPaint}"]`)?.getAttribute('d') ?? null).toBe(referenceEye?.getAttribute('d') ?? null);
      }
    }
    expect(native.still()).toBe('data:image/svg+xml,' + encodeURIComponent(assistantAvatarSvg(seed)));
  }
});
it('refuses an expanded future model instead of fabricating a compact lookalike', () => {
  const player = createAssistantAvatarPlayer({ ...resolveAssistantAvatar('x'), shape: 'square' }, 'x', 'working', true);
  const model = player.advance(0).model;
  if (model.mode !== 'morph') throw new Error('expected reference compact model');
  expect(() => workingAvatarModelSvg({ ...model, zoom: 2 }, '0 0 256 256', '')).toThrow('unsupported_native_working_avatar_model');
});
