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
  numberCells,
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
    expect(flipPlan('Read 1 file', 'Read 1 file', false, true)).toBe('replace');
  });
});

describe('formatted duration place identities', () => {
  it('retains units and tenths when an integer grows from one to two digits', () => {
    const before = numberCells('9.9s'), after = numberCells('10.0s');
    expect(after.find(cell => cell.key === before[0].key)?.text).toBe('0');
    expect(after.find(cell => cell.key === before[2].key)?.text).toBe('0');
    expect(after.filter(cell => !before.some(old => old.key === cell.key)).map(cell => cell.text)).toEqual(['1']);
  });
  it('keeps seconds attached to seconds when minutes appear, and removes tenths', () => {
    const before = numberCells('59.9s'), after = numberCells('1m 0s');
    expect(after.find(cell => cell.key === before[1].key)?.text).toBe('0');
    expect(after.find(cell => cell.key === before[0].key)).toBeUndefined();
    expect(after.find(cell => cell.key === before[3].key)).toBeUndefined();
    expect(new Set(after.map(cell => cell.key)).size).toBe(after.length);
  });
  it.each(['', '9s', '10.0s', '1m 0s', '59m 59s', '1:00', '-1.5', '等待 9 秒', '20%'])('retains the existing display format %s', value => {
    expect(numberCells(value).map(cell => cell.text).join('')).toBe(value);
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
