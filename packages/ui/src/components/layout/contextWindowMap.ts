import type { Message, Part } from '@/lib/opencode/v2-types';
import { deriveMessageRole } from '@/components/chat/message/messageRole';

type SessionMessage = { info: Message; parts: Part[] };

export type ContextPartKind = 'system' | 'files' | 'results' | 'chat';

export const CONTEXT_PART_ORDER: readonly ContextPartKind[] = ['system', 'files', 'results', 'chat'];

export type ContextPieceRole = 'system' | 'user' | 'assistant' | 'thinking' | 'call' | 'result';

/** A stretch of the transcript an item stands for. `value` is stringified only when opened. */
export type ContextPiece = {
  role: ContextPieceRole;
  name?: string;
  value: unknown;
};

export type ContextItem = {
  id: string;
  kind: 'baseline' | 'turn' | 'file' | 'tool';
  /** Turn number, file path or tool name; the baseline has no name. */
  name: string;
  count: number;
  tokens: number;
  pieces: ContextPiece[];
};

/** What the pointer is over, so the rest of the card can light up what it stands for. */
export type ContextFocus =
  | { type: 'part'; kind: ContextPartKind | 'free' }
  | { type: 'tile'; key: string }
  | { type: 'item'; kind: ContextPartKind; id: string }
  | null;

export const CONTEXT_CELLS = 400;

/** One cell of the block grid: the part it belongs to and the index of its item in that part. */
export type ContextCell = { kind: ContextPartKind; item: number } | null;

export type ContextPart = {
  kind: ContextPartKind;
  tokens: number;
  /** Largest first. */
  items: ContextItem[];
};

type Rect = { x: number; y: number; w: number; h: number };
type Weighted<T> = { v: number; ref: T };
type Placed<T> = Rect & { a: Weighted<T> };

export type MapTile = Rect & {
  key: string;
  kind: ContextPartKind | 'free';
  /** The item this tile shows; null for a whole part, a group of small items or free space. */
  item: ContextItem | null;
  /** The items the tile stands for. */
  items: ContextItem[];
  tokens: number;
};

const WIDE_CHAR_START = 0x2e80;

// CJK text costs about a token per character, other text about a quarter.
const estimateTextTokens = (text: string): number => {
  let wide = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= WIDE_CHAR_START) wide += 1;
  }
  return wide + (text.length - wide) / 4;
};

const jsonLength = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

const readPathOf = (input: unknown): string => {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['filePath', 'path', 'file_path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
};

const bump = (
  map: Map<string, ContextItem>,
  item: Omit<ContextItem, 'count' | 'tokens' | 'pieces'>,
  tokens: number,
  pieces: ContextPiece[],
) => {
  const existing = map.get(item.id);
  if (existing) {
    existing.count += 1;
    existing.tokens += tokens;
    existing.pieces.push(...pieces);
    return;
  }
  map.set(item.id, { ...item, count: 1, tokens, pieces: [...pieces] });
};

const byTokensDesc = (a: ContextItem, b: ContextItem) => b.tokens - a.tokens;

/**
 * Splits the measured context size into parts. Only the total and the first
 * request's input are measured: the rest is estimated from the transcript's
 * text and scaled so the parts add up to `used`.
 */
export const buildContextParts = (
  messages: SessionMessage[],
  measured: { used: number; firstRequestInput: number; systemPrompt?: string },
): ContextPart[] => {
  const { used, firstRequestInput, systemPrompt } = measured;
  if (used <= 0) return [];

  const files = new Map<string, ContextItem>();
  const tools = new Map<string, ContextItem>();
  const turns: ContextItem[] = [];
  let turn: ContextItem | null = null;
  let firstUserTokens = 0;
  let firstUserDone = false;

  for (const message of messages) {
    const isUser = deriveMessageRole(message.info).isUser;
    if (isUser || !turn) {
      turn = { id: `turn:${turns.length + 1}`, kind: 'turn', name: String(turns.length + 1), count: 1, tokens: 0, pieces: [] };
      turns.push(turn);
    }
    const inFirstUser = isUser && !firstUserDone;

    for (const part of message.parts) {
      const record = part as unknown as Record<string, unknown>;
      if (record.type === 'text' || record.type === 'reasoning') {
        if (record.ignored === true || typeof record.text !== 'string') continue;
        const tokens = estimateTextTokens(record.text);
        turn.tokens += tokens;
        if (inFirstUser) firstUserTokens += tokens;
        if (record.text.length > 0) {
          turn.pieces.push({ role: record.type === 'reasoning' ? 'thinking' : isUser ? 'user' : 'assistant', value: record.text });
        }
        continue;
      }
      if (record.type !== 'tool') continue;

      const state = record.state as { input?: unknown; output?: unknown; error?: unknown; time?: { compacted?: number } } | undefined;
      if (!state) continue;
      const name = typeof record.tool === 'string' && record.tool.length > 0 ? record.tool : 'tool';
      // The call itself is something the assistant said; what came back is the result.
      turn.tokens += jsonLength(state.input) / 4;
      turn.pieces.push({ role: 'call', name, value: state.input });
      if (state.time?.compacted) continue;
      const resultTokens = (jsonLength(state.output) + jsonLength(state.error)) / 4;
      if (resultTokens <= 0) continue;

      const result: ContextPiece = { role: 'result', name, value: state.output ?? state.error };
      const path = name === 'read' ? readPathOf(state.input) : '';
      if (path) bump(files, { id: `file:${path}`, kind: 'file', name: path }, resultTokens, [{ ...result, name: path }]);
      else bump(tools, { id: `tool:${name}`, kind: 'tool', name }, resultTokens, [{ role: 'call', name, value: state.input }, result]);
    }
    if (isUser) firstUserDone = true;
  }

  const itemsTotal = [...turns, ...files.values(), ...tools.values()].reduce((sum, item) => sum + item.tokens, 0);
  const baseline = Math.max(0, firstRequestInput - firstUserTokens);

  let baselineTokens: number;
  let scale: number;
  if (itemsTotal <= 0) {
    baselineTokens = used;
    scale = 0;
  } else if (baseline < used) {
    baselineTokens = baseline;
    scale = (used - baseline) / itemsTotal;
  } else {
    // The window is smaller than the first request was (the history was compacted).
    const ratio = used / (baseline + itemsTotal);
    baselineTokens = baseline * ratio;
    scale = ratio;
  }

  const scaled = (items: Iterable<ContextItem>): ContextItem[] => [...items]
    .map((item) => ({ ...item, tokens: item.tokens * scale }))
    .filter((item) => item.tokens > 0.5)
    .sort(byTokensDesc);
  const groups: Record<ContextPartKind, ContextItem[]> = {
    system: baselineTokens > 0.5
      ? [{
          id: 'baseline', kind: 'baseline', name: '', count: 1, tokens: baselineTokens,
          pieces: systemPrompt ? [{ role: 'system', value: systemPrompt }] : [],
        }]
      : [],
    files: scaled(files.values()),
    results: scaled(tools.values()),
    chat: scaled(turns),
  };

  return CONTEXT_PART_ORDER
    .filter((kind) => groups[kind].length > 0)
    .map((kind) => ({ kind, items: groups[kind], tokens: groups[kind].reduce((sum, item) => sum + item.tokens, 0) }));
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/** How many more requests fit, at the pace the session's requests grew. */
export const estimateRequestHeadroom = (requestTotals: number[], free: number): number | null => {
  const steps: number[] = [];
  for (let index = 1; index < requestTotals.length; index += 1) {
    const growth = requestTotals[index] - requestTotals[index - 1];
    // A drop means the history was compacted; that isn't a growth step.
    if (growth > 0 && requestTotals[index] >= requestTotals[index - 1] * 0.6) steps.push(growth);
  }
  const pace = median(steps);
  return pace > 0 ? Math.floor(free / pace) : null;
};

export const contextHealth = (fill: number): 'ok' | 'warn' | 'bad' => (fill < 0.75 ? 'ok' : fill < 0.9 ? 'warn' : 'bad');

export const formatCompactTokens = (value: number): string => {
  const n = Math.max(0, Math.round(value || 0));
  const short = (x: number, digits: number) => x.toFixed(digits).replace(/\.0+$/, '');
  if (n >= 1e6) return `${short(n / 1e6, n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${short(n / 1e3, n >= 1e5 ? 0 : 1)}K`;
  return String(n);
};

// Squarified treemap (Bruls, Huizing, van Wijk): rects whose sides are as
// near alike as they can be, laid in the order of `input`.
const squarify = <T>(input: Array<Weighted<T>>, bounds: Rect): Array<Placed<T>> => {
  const out: Array<Placed<T>> = [];
  const vals = input.filter((a) => a.v > 0);
  const total = vals.reduce((sum, a) => sum + a.v, 0);
  let { x, y, w, h } = bounds;
  if (!total || w <= 0 || h <= 0) return out;
  const k = (w * h) / total;

  const worst = (row: Array<Weighted<T>>, side: number) => {
    let sum = 0;
    let hi = 0;
    let lo = Infinity;
    for (const a of row) {
      const area = a.v * k;
      sum += area;
      hi = Math.max(hi, area);
      lo = Math.min(lo, area);
    }
    return Math.max((side * side * hi) / (sum * sum), (sum * sum) / (side * side * lo));
  };

  const lay = (row: Array<Weighted<T>>) => {
    const sum = row.reduce((s, a) => s + a.v * k, 0);
    if (w >= h) {
      const columnWidth = sum / h;
      let cursor = y;
      for (const a of row) {
        const cellHeight = (a.v * k) / columnWidth;
        out.push({ a, x, y: cursor, w: columnWidth, h: cellHeight });
        cursor += cellHeight;
      }
      x += columnWidth;
      w -= columnWidth;
    } else {
      const rowHeight = sum / w;
      let cursor = x;
      for (const a of row) {
        const cellWidth = (a.v * k) / rowHeight;
        out.push({ a, x: cursor, y, w: cellWidth, h: rowHeight });
        cursor += cellWidth;
      }
      y += rowHeight;
      h -= rowHeight;
    }
  };

  let row: Array<Weighted<T>> = [];
  for (const a of vals) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, a], side) <= worst(row, side)) {
      row.push(a);
      continue;
    }
    lay(row);
    row = [a];
  }
  if (row.length) lay(row);
  return out;
};

// A tile smaller than this many px² can't be read or pointed at, and one
// narrower than TILE_SIDE px is a sliver: their values are raised to fit.
const TILE_MIN = 1500;
const TILE_MAX = 12;
const TILE_FLOOR = 700;
const TILE_SIDE = 16;
const TILE_STRIP = 14;

const floored = <T>(vals: Array<Weighted<T>>, area: number): Array<Weighted<T>> => {
  const sum = vals.reduce((s, a) => s + a.v, 0);
  const lo = (sum * TILE_FLOOR) / Math.max(1, area);
  return vals.map((a) => ({ ...a, v: Math.max(a.v, lo) }));
};

/**
 * The window as a grid of CONTEXT_CELLS cells, a cell for each share of it,
 * coloured by the part that fills it. A part of any size has at least one.
 */
export const layoutContextCells = (parts: ContextPart[], used: number, limit: number | null): ContextCell[] => {
  const scale = Math.max(limit ?? 0, used, 1);
  const filled = Math.min(CONTEXT_CELLS, Math.round((used / scale) * CONTEXT_CELLS));
  const sum = parts.reduce((s, part) => s + part.tokens, 0) || 1;

  // Largest remainder, so the cells add up to `filled`.
  const want = parts.map((part) => (part.tokens / sum) * filled);
  const got = want.map((w) => Math.max(1, Math.floor(w)));
  let left = filled - got.reduce((s, n) => s + n, 0);
  const order = want.map((w, index) => [w - Math.floor(w), index] as const).sort((a, b) => b[0] - a[0]);
  for (let j = 0; left > 0 && order.length; j = (j + 1) % order.length, left -= 1) got[order[j][1]] += 1;
  for (let j = got.length - 1; left < 0 && j >= 0; j -= 1) {
    while (left < 0 && got[j] > 1) {
      got[j] -= 1;
      left += 1;
    }
  }

  const cells: ContextCell[] = [];
  parts.forEach((part, partIndex) => {
    const itemsSum = part.items.reduce((s, item) => s + item.tokens, 0) || 1;
    let at = 0;
    let acc = 0;
    for (let c = 0; c < got[partIndex]; c += 1) {
      // The item whose share the cell's middle falls in.
      const mid = ((c + 0.5) / got[partIndex]) * itemsSum;
      while (at < part.items.length - 1 && acc + part.items[at].tokens < mid) {
        acc += part.items[at].tokens;
        at += 1;
      }
      cells.push({ kind: part.kind, item: part.items.length ? at : -1 });
    }
  });
  while (cells.length < CONTEXT_CELLS) cells.push(null);
  return cells.slice(0, CONTEXT_CELLS);
};

type ItemRef = { item?: ContextItem; rest?: ContextItem[] };

/**
 * Lays the window out on a map `width`×`height` px: the used share and the
 * free space side by side along the long side, the parts squarified in the
 * used share and each part's items in the part.
 */
export const layoutContextMap = (
  parts: ContextPart[],
  used: number,
  limit: number | null,
  width: number,
  height: number,
): MapTile[] => {
  const tiles: MapTile[] = [];
  if (used <= 0 || width <= 0 || height <= 0) return tiles;
  const scale = Math.max(limit ?? 0, used, 1);
  const across = width >= height;
  const long = across ? width : height;

  // The used share is drawn on a gentle curve (share^0.35), so a window 8%
  // full still has room to read its tiles; the free tile says its own share.
  let usedLength = long;
  if (used < scale) usedLength = Math.min(long, Math.max(long * Math.pow(used / scale, 0.35), Math.min(long, 36)));
  const usedRect: Rect = across ? { x: 0, y: 0, w: usedLength, h: height } : { x: 0, y: 0, w: width, h: usedLength };

  const partVals = floored(parts.map((part) => ({ v: part.tokens, ref: part })), usedRect.w * usedRect.h);
  let partRects = squarify(partVals, usedRect);
  for (let pass = 0; pass < 8; pass += 1) {
    const thin = partRects.filter((r) => Math.min(r.w, r.h) < TILE_SIDE);
    if (!thin.length) break;
    for (const r of thin) r.a.v *= (TILE_SIDE / Math.max(1, Math.min(r.w, r.h))) * 1.05;
    partRects = squarify(partVals, usedRect);
  }

  for (const r of partRects) {
    const part = r.a.ref;
    const whole: MapTile = { key: part.kind, kind: part.kind, item: null, items: part.items, tokens: part.tokens, x: r.x, y: r.y, w: r.w, h: r.h };
    const area = r.w * r.h;
    if (!part.items.length || area < TILE_MIN * 2) {
      tiles.push(whole);
      continue;
    }

    const kept: ContextItem[] = [];
    const rest: ContextItem[] = [];
    for (const item of part.items) {
      if (kept.length < TILE_MAX && (item.tokens / part.tokens) * area >= TILE_MIN) kept.push(item);
      else rest.push(item);
    }
    const vals: Array<Weighted<ItemRef>> = kept.map((item) => ({ v: item.tokens, ref: { item } }));
    if (rest.length === 1 && !kept.length) vals.push({ v: rest[0].tokens, ref: { item: rest[0] } });
    else if (rest.length) vals.push({ v: rest.reduce((s, item) => s + item.tokens, 0), ref: { rest } });

    const laid = squarify(floored(vals, area), r);
    // A part whose items would leave one a strip too thin to read is one tile.
    if (laid.some((q) => Math.min(q.w, q.h) < TILE_STRIP)) {
      tiles.push(whole);
      continue;
    }
    for (const q of laid) {
      const { item, rest: group } = q.a.ref;
      const items = item ? [item] : group ?? [];
      tiles.push({
        key: `${part.kind}:${item ? item.id : 'rest'}`,
        kind: part.kind,
        item: item ?? null,
        items,
        tokens: items.reduce((s, it) => s + it.tokens, 0),
        x: q.x, y: q.y, w: q.w, h: q.h,
      });
    }
  }

  if (used < scale) {
    const free: Rect = across
      ? { x: usedLength, y: 0, w: width - usedLength, h: height }
      : { x: 0, y: usedLength, w: width, h: height - usedLength };
    tiles.push({ key: 'free', kind: 'free', item: null, items: [], tokens: scale - used, ...free });
  }
  return tiles;
};
