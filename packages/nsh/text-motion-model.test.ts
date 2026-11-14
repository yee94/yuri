import { describe, expect, it } from 'vitest';
import {
  CHARACTER_FADE_DURATION,
  CHARACTER_FADE_MAX_DELAY,
  FLIP_DURATION,
  SHIMMER_DURATION,
  characterFadeDelay,
  characterFadePlan,
  characterFadeTotal,
  flipPlan,
} from './text-motion-model';

describe('text motion timings follow the Web animations', () => {
  it('keeps FlipUpText, shimmer and generate-effect durations', () => {
    // packages/ui/src/index.css: .yuri-summary-flip-in/out 280ms, .animate-text-shimmer 1.7s,
    // components/ui/text.tsx: 140ms per character with a 140ms stagger cap.
    expect(FLIP_DURATION).toBe(280);
    expect(SHIMMER_DURATION).toBe(1700);
    expect(CHARACTER_FADE_DURATION).toBe(140);
    expect(CHARACTER_FADE_MAX_DELAY).toBe(140);
  });
});

describe('flipPlan', () => {
  it('holds while the summary text is unchanged', () => {
    expect(flipPlan('Read 1 file', 'Read 1 file', true, false)).toBe('hold');
    expect(flipPlan('', '', true, false)).toBe('hold');
  });

  it('replaces without a flip when the group is settled', () => {
    expect(flipPlan('Read 1 file', 'Read 2 files', false, false)).toBe('replace');
  });

  it('replaces without a flip when there was no previous summary', () => {
    expect(flipPlan('', 'Read 1 file', true, false)).toBe('replace');
  });

  it('flips when an active group gains a new summary', () => {
    expect(flipPlan('Read 1 file', 'Read 2 files', true, false)).toBe('flip');
  });

  it('defers to the running flip instead of replaying it', () => {
    // Streaming counts change faster than 280ms: the running flip finishes on the newest text.
    expect(flipPlan('Read 1 file', 'Read 2 files', true, true)).toBe('defer');
    expect(flipPlan('Read 2 files', 'Read 3 files', true, true)).toBe('defer');
  });

  it('abandons a running flip when the group settles', () => {
    expect(flipPlan('Read 1 file', 'Read 2 files', false, true)).toBe('replace');
  });
});

describe('characterFadeDelay', () => {
  it('staggers by 4.5ms and caps at 140ms', () => {
    expect(characterFadeDelay(0)).toBe(0);
    expect(characterFadeDelay(1)).toBe(4.5);
    expect(characterFadeDelay(10)).toBe(45);
    expect(characterFadeDelay(31)).toBe(139.5);
    expect(characterFadeDelay(32)).toBe(CHARACTER_FADE_MAX_DELAY);
    expect(characterFadeDelay(140)).toBe(CHARACTER_FADE_MAX_DELAY);
  });

  it('never goes negative', () => {
    expect(characterFadeDelay(-3)).toBe(0);
  });
});

describe('characterFadeTotal', () => {
  it('ends when the last character finished fading', () => {
    expect(characterFadeTotal(0)).toBe(CHARACTER_FADE_DURATION);
    expect(characterFadeTotal(1)).toBe(CHARACTER_FADE_DURATION);
    expect(characterFadeTotal(2)).toBe(4.5 + CHARACTER_FADE_DURATION);
    // Past the stagger cap every character starts at the cap.
    expect(characterFadeTotal(60)).toBe(CHARACTER_FADE_MAX_DELAY + CHARACTER_FADE_DURATION);
  });
});

describe('characterFadePlan', () => {
  it('splits a short text that appeared where nothing was shown', () => {
    expect(characterFadePlan('', 'Read')).toEqual(['R', 'e', 'a', 'd']);
  });

  it('does not replay for an unchanged or replaced text', () => {
    expect(characterFadePlan('Read', 'Read')).toBeNull();
    // A recycled transcript row that binds another tool must not flicker.
    expect(characterFadePlan('Read', 'Bash')).toBeNull();
  });

  it('does not split an empty text', () => {
    expect(characterFadePlan('', '')).toBeNull();
  });

  it('leaves long text to the whole-text fade', () => {
    const long = 'src/components/chat/message/parts/ToolPart.tsx';
    expect(characterFadePlan('', long)).toBeNull();
    expect(characterFadePlan('', 'x'.repeat(24))).not.toBeNull();
    expect(characterFadePlan('', 'x'.repeat(25))).toBeNull();
    expect(characterFadePlan('', 'x'.repeat(25), 40)).toHaveLength(25);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(characterFadePlan('', '😀😀')).toEqual(['😀', '😀']);
  });
});
