import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@/lib/opencode/v2-types';
import {
  buildContextParts,
  contextHealth,
  estimateRequestHeadroom,
  formatCompactTokens,
  layoutContextCells,
  layoutContextMap,
} from './contextWindowMap';

const user = (id: string, text: string) => ({
  info: { id, role: 'user', sessionID: 's', time: { created: 1 } } as unknown as Message,
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text }] as unknown as Part[],
});

const assistant = (id: string, parts: unknown[]) => ({
  info: { id, role: 'assistant', sessionID: 's', time: { created: 2 } } as unknown as Message,
  parts: parts as Part[],
});

const readTool = (id: string, path: string, output: string) => ({
  id, sessionID: 's', messageID: 'a', type: 'tool', tool: 'read', callID: id,
  state: { status: 'completed', input: { filePath: path }, output },
});

const bashTool = (id: string, output: string) => ({
  id, sessionID: 's', messageID: 'a', type: 'tool', tool: 'bash', callID: id,
  state: { status: 'completed', input: { command: 'ls' }, output },
});

describe('buildContextParts', () => {
  it('adds up to the measured total and separates files from other tool results', () => {
    const messages = [
      user('u1', 'hello there'),
      assistant('a1', [readTool('t1', '/repo/a.ts', 'x'.repeat(4000)), bashTool('t2', 'y'.repeat(2000))]),
    ];
    const parts = buildContextParts(messages, { used: 5000, firstRequestInput: 2000 });
    const total = parts.reduce((sum, part) => sum + part.tokens, 0);
    expect(total).toBeCloseTo(5000, 3);
    expect(parts.map((part) => part.kind)).toEqual(['system', 'files', 'results', 'chat']);
    expect(parts.find((part) => part.kind === 'files')?.items[0].name).toBe('/repo/a.ts');
    expect(parts.find((part) => part.kind === 'results')?.items[0].name).toBe('bash');
  });

  it('groups repeated reads of one file into one item', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', [readTool('t1', '/repo/a.ts', 'x'.repeat(400)), readTool('t2', '/repo/a.ts', 'x'.repeat(400))]),
    ];
    const files = buildContextParts(messages, { used: 3000, firstRequestInput: 1000 }).find((part) => part.kind === 'files');
    expect(files?.items).toHaveLength(1);
    expect(files?.items[0].count).toBe(2);
  });

  it('shrinks everything to fit when the window is smaller than the first request', () => {
    const messages = [user('u1', 'hi'), assistant('a1', [bashTool('t1', 'y'.repeat(4000))])];
    const parts = buildContextParts(messages, { used: 500, firstRequestInput: 2000 });
    expect(parts.reduce((sum, part) => sum + part.tokens, 0)).toBeCloseTo(500, 3);
  });

  it('puts everything in the initial prompt when the transcript has no text to estimate from', () => {
    const parts = buildContextParts([], { used: 1200, firstRequestInput: 1200 });
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('system');
    expect(parts[0].tokens).toBe(1200);
  });

  it('returns nothing when nothing is measured', () => {
    expect(buildContextParts([user('u1', 'hi')], { used: 0, firstRequestInput: 0 })).toEqual([]);
  });
});

describe('layoutContextMap', () => {
  const parts = buildContextParts(
    [user('u1', 'hello'), assistant('a1', [readTool('t1', '/repo/a.ts', 'x'.repeat(8000)), bashTool('t2', 'y'.repeat(4000))])],
    { used: 6000, firstRequestInput: 2000 },
  );

  it('keeps every tile inside the map and adds a free tile for the unused window', () => {
    const tiles = layoutContextMap(parts, 6000, 100000, 800, 260);
    expect(tiles.some((tile) => tile.kind === 'free')).toBe(true);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(-0.001);
      expect(tile.y).toBeGreaterThanOrEqual(-0.001);
      expect(tile.x + tile.w).toBeLessThanOrEqual(800.001);
      expect(tile.y + tile.h).toBeLessThanOrEqual(260.001);
    }
  });

  it('has no free tile when the window is full or its size is unknown', () => {
    expect(layoutContextMap(parts, 6000, null, 800, 260).some((tile) => tile.kind === 'free')).toBe(false);
    expect(layoutContextMap(parts, 6000, 6000, 800, 260).some((tile) => tile.kind === 'free')).toBe(false);
  });

  it('lays nothing out without a size', () => {
    expect(layoutContextMap(parts, 6000, 100000, 0, 0)).toEqual([]);
  });
});

describe('layoutContextCells', () => {
  const parts = buildContextParts(
    [user('u1', 'hello'), assistant('a1', [readTool('t1', '/repo/a.ts', 'x'.repeat(8000)), bashTool('t2', 'y'.repeat(4000))])],
    { used: 6000, firstRequestInput: 2000 },
  );

  it('fills a share of the cells with the used window, every part getting at least one', () => {
    const cells = layoutContextCells(parts, 6000, 24000);
    expect(cells).toHaveLength(400);
    expect(cells.filter(Boolean)).toHaveLength(100);
    for (const part of parts) expect(cells.some((cell) => cell?.kind === part.kind)).toBe(true);
  });

  it('keeps pieces of a read file and its text on the item', () => {
    const files = parts.find((part) => part.kind === 'files');
    expect(files?.items[0].pieces[0]).toMatchObject({ role: 'result', name: '/repo/a.ts' });
  });
});

describe('estimateRequestHeadroom', () => {
  it('divides the free space by the median growth per request', () => {
    expect(estimateRequestHeadroom([1000, 1100, 1200, 1300], 1000)).toBe(10);
  });

  it('ignores a compaction drop and has no answer without growth', () => {
    expect(estimateRequestHeadroom([5000, 1000, 1100], 1000)).toBe(10);
    expect(estimateRequestHeadroom([1000], 1000)).toBeNull();
  });
});

describe('formatting', () => {
  it('compacts token counts', () => {
    expect(formatCompactTokens(950)).toBe('950');
    expect(formatCompactTokens(50900)).toBe('50.9K');
    expect(formatCompactTokens(400000)).toBe('400K');
    expect(formatCompactTokens(1_250_000)).toBe('1.25M');
  });

  it('grades fill levels', () => {
    expect(contextHealth(0.5)).toBe('ok');
    expect(contextHealth(0.8)).toBe('warn');
    expect(contextHealth(0.95)).toBe('bad');
  });
});
