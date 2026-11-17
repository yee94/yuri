import React from 'react';
import { useLocalStorage, useResizeObserver } from '@reactuses/core';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import './context-window.css';
import { ContextItemLabel, ContextTextDialog, type ContextTextTarget } from './ContextTextDialog';
import { itemName, itemTag, partLabel } from './contextWindowLabels';
import {
  type ContextFocus,
  type ContextItem,
  type ContextPart,
  type ContextPartKind,
  type MapTile,
  contextHealth,
  estimateRequestHeadroom,
  formatCompactTokens,
  layoutContextCells,
  layoutContextMap,
} from './contextWindowMap';

const MAP_MIN_HEIGHT = 132;
const MAP_MAX_HEIGHT = 232;
const MAP_RATIO = 3.1;
const TILE_GAP = 1.5;
const NARROW_WIDTH = 520;
const ROWS_COLLAPSED = 8;
const LOOK_STORAGE_KEY = 'yuri.contextWindowLook';

// Paths, not rects: the global button rule clears every rect's fill.
const roundedRect = (x: number, y: number, w: number, h: number, r: number): string =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;

const LOOK_MAP = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d={`${roundedRect(1.5, 2, 5.5, 12, 1.6)}${roundedRect(8.5, 2, 6, 6.5, 1.6)}${roundedRect(8.5, 10, 6, 4, 1.4)}`} />
  </svg>
);
const LOOK_GRID = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d={[2, 6.5, 11].flatMap((y) => [2, 6.5, 11].map((x) => roundedRect(x, y, 3, 3, 0.8))).join('')} />
  </svg>
);

const percentOf = (value: number, whole: number): number => Math.round((value / Math.max(1, whole)) * 100);

const isFocusedItem = (focus: ContextFocus, kind: ContextPartKind, items: ContextItem[]): boolean =>
  focus?.type === 'item' && focus.kind === kind && items.some((item) => item.id === focus.id);

const tileDimmed = (focus: ContextFocus, tile: MapTile): boolean => {
  if (!focus) return false;
  if (focus.type === 'part') return tile.kind !== focus.kind;
  if (focus.type === 'tile') return tile.key !== focus.key;
  return tile.kind === 'free' || !isFocusedItem(focus, tile.kind, tile.items);
};

const Spark: React.FC<{ series: number[]; limit: number | null }> = ({ series, limit }) => {
  const W = 240;
  const H = 34;
  const pad = 3;
  const peak = Math.max(...series, 1);
  // Scaled to the session's peak, so a session far from its window still shows how it grew.
  const top = limit && peak > limit * 0.6 ? Math.max(limit, peak) : peak * 1.2;
  const x = (index: number) => (series.length < 2 ? W / 2 : pad + (index / (series.length - 1)) * (W - pad * 2));
  const y = (value: number) => H - pad - (value / top) * (H - pad * 2);
  const points = series.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const last = series.length - 1;
  return (
    <span className="yuri-ctx-spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {limit && limit <= top ? <line className="win" x1={0} x2={W} y1={y(limit)} y2={y(limit)} /> : null}
        <path className="area" d={`M${points[0]} L${points.slice(1).join(' L')} L${x(last).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`} />
        <polyline className="line" points={points.join(' ')} />
      </svg>
      <span className="at" style={{ left: `${((x(last) / W) * 100).toFixed(2)}%`, top: `${((y(series[last]) / H) * 100).toFixed(2)}%` }} />
    </span>
  );
};

export type ContextWindowCardProps = {
  /** Tokens the window holds now. */
  used: number;
  /** The model's window; null when it isn't known. */
  limit: number | null;
  parts: ContextPart[];
  /** Tokens of each request so far, oldest first. */
  requestTotals: number[];
  /** What the last request read from the prompt cache, when it counted one. */
  cache: { read: number; total: number } | null;
};

export const ContextWindowCard: React.FC<ContextWindowCardProps> = ({ used, limit, parts, requestTotals, cache }) => {
  const { t } = useI18n();
  const vizRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const [focus, setFocus] = React.useState<ContextFocus>(null);
  const [tab, setTab] = React.useState<'all' | ContextPartKind>('all');
  const [expandedRows, setExpandedRows] = React.useState(false);
  const [textTarget, setTextTarget] = React.useState<ContextTextTarget | null>(null);
  const [storedLook, setStoredLook] = useLocalStorage(LOOK_STORAGE_KEY, 'map');
  const look = storedLook === 'grid' ? 'grid' : 'map';
  useResizeObserver(vizRef, ([entry]) => {
    if (entry) setWidth(Math.round(entry.contentRect.width));
  });

  const narrow = width > 0 && width <= NARROW_WIDTH;
  const height = Math.min(MAP_MAX_HEIGHT, Math.max(MAP_MIN_HEIGHT, Math.round(width / (narrow ? 2 : MAP_RATIO))));
  const tiles = React.useMemo(
    () => (look === 'map' ? layoutContextMap(parts, used, limit, width, height) : []),
    [look, parts, used, limit, width, height],
  );
  const cells = React.useMemo(() => (look === 'grid' ? layoutContextCells(parts, used, limit) : []), [look, parts, used, limit]);

  const free = limit && limit > used ? limit - used : 0;
  const fill = limit && limit > 0 ? used / limit : 0;
  const health = limit ? contextHealth(fill) : null;
  const headroom = React.useMemo(() => (free > 0 ? estimateRequestHeadroom(requestTotals, free) : null), [requestTotals, free]);

  const activeTab = tab === 'all' || parts.some((part) => part.kind === tab) ? tab : 'all';
  const rows = React.useMemo(
    () => parts
      .filter((part) => activeTab === 'all' || part.kind === activeTab)
      .flatMap((part) => part.items.map((item) => ({ item, kind: part.kind })))
      .sort((a, b) => b.item.tokens - a.item.tokens),
    [parts, activeTab],
  );
  const mostTokens = Math.max(1, ...rows.map((row) => row.item.tokens));
  const visibleRows = expandedRows ? rows : rows.slice(0, ROWS_COLLAPSED);

  const tileName = (tile: MapTile): string => {
    if (tile.kind === 'free') return t('contextSidebar.window.freeSpace');
    if (!tile.item) return tile.key !== tile.kind ? t('contextSidebar.window.more', { count: tile.items.length }) : partLabel(t, tile.kind);
    const { item } = tile;
    const name = item.kind === 'file' ? itemName(t, item).slice(item.name.lastIndexOf('/') + 1) : itemName(t, item);
    return item.count > 1 && item.kind !== 'turn' ? `${name} ×${item.count}` : name;
  };

  const tileValue = (tile: MapTile): string => {
    if (tile.kind === 'free') return `${formatCompactTokens(tile.tokens)} · ${percentOf(tile.tokens, Math.max(limit ?? 0, used))}%`;
    if (!tile.item && tile.key === tile.kind) return formatCompactTokens(tile.tokens);
    return `${formatCompactTokens(tile.tokens)} · ${partLabel(t, tile.kind)}`;
  };

  const legend: Array<{ kind: ContextPartKind | 'free'; label: string; tokens: number }> = [
    ...parts.map((part) => ({ kind: part.kind, label: partLabel(t, part.kind), tokens: part.tokens })),
    ...(free > 0 ? [{ kind: 'free' as const, label: t('contextSidebar.window.freeSpace'), tokens: free }] : []),
  ];

  const tabs: Array<{ id: 'all' | ContextPartKind; label: string }> = [
    { id: 'all', label: t('contextSidebar.window.tab.all') },
    ...parts.map((part) => ({ id: part.kind, label: partLabel(t, part.kind) })),
  ];

  const clearFocus = () => setFocus(null);

  return (
    <div className={cn('yuri-ctx-card', narrow && 'is-narrow')}>
      <div className="yuri-ctx-title">{t('contextSidebar.window.title')}</div>

      <div className="yuri-ctx-top">
        <div className="yuri-ctx-stat">
          <div className="yuri-ctx-label">
            <span>{t('contextSidebar.window.used')}</span>
            {health ? <span className={cn('yuri-ctx-health', `is-${health}`)}>{t(`contextSidebar.window.health.${health}`)}</span> : null}
          </div>
          <div className="yuri-ctx-big">
            <b>{formatCompactTokens(used)}</b>
            {limit ? <span>/ {formatCompactTokens(limit)} {t('contextSidebar.window.tokens')}</span> : <span>{t('contextSidebar.window.tokens')}</span>}
          </div>
          <div className="yuri-ctx-sub">
            {limit
              ? [
                  t('contextSidebar.context.percentUsed', { percent: Math.round(fill * 100) }),
                  headroom === null
                    ? null
                    : headroom >= 999
                      ? t('contextSidebar.window.headroomPlenty')
                      : headroom > 1
                        ? t('contextSidebar.window.headroom', { count: headroom })
                        : null,
                ].filter(Boolean).join(' · ')
              : t('contextSidebar.window.limitUnknown')}
          </div>
        </div>

        {cache ? (
          <div className="yuri-ctx-stat">
            <div className="yuri-ctx-label">{t('contextSidebar.window.cache.title')}</div>
            <div className="yuri-ctx-big">
              <b>{percentOf(cache.read, cache.total)}%</b>
              <span>{t('contextSidebar.window.cache.hit')}</span>
            </div>
            <span className="yuri-ctx-bar"><i style={{ width: `${Math.min(100, (cache.read / Math.max(1, cache.total)) * 100).toFixed(1)}%` }} /></span>
            <div className="yuri-ctx-sub">
              {t('contextSidebar.window.cache.detail', {
                cached: formatCompactTokens(cache.read),
                fresh: formatCompactTokens(cache.total - cache.read),
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div ref={vizRef} className="yuri-ctx-viz">
        {look === 'map' ? (
          <div
            role="img"
            aria-label={`${formatCompactTokens(used)}${limit ? ` / ${formatCompactTokens(limit)}` : ''}`}
            className="yuri-ctx-map"
            style={{ height }}
            onPointerLeave={clearFocus}
          >
            {width > 0 ? tiles.map((tile) => {
              const isFree = tile.kind === 'free';
              const bare = tile.w < 54 || tile.h < 30;
              const low = !bare && tile.h < 46;
              const dimmed = tileDimmed(focus, tile);
              const name = tileName(tile);
              const value = tileValue(tile);
              return (
                <div
                  key={tile.key}
                  role={isFree ? undefined : 'button'}
                  tabIndex={isFree ? undefined : 0}
                  title={`${name} · ${value}`}
                  className={cn('yuri-ctx-tile', `yuri-ctx-k-${tile.kind}`, isFree && 'is-free', bare && 'is-bare', low && 'is-low', dimmed && 'is-dim')}
                  style={{
                    left: tile.x + TILE_GAP,
                    top: tile.y + TILE_GAP,
                    width: Math.max(0, tile.w - TILE_GAP * 2),
                    height: Math.max(0, tile.h - TILE_GAP * 2),
                  }}
                  onPointerEnter={() => setFocus({ type: 'tile', key: tile.key })}
                  onClick={isFree ? undefined : () => setTextTarget({ kind: tile.kind as ContextPartKind, itemId: tile.item?.id ?? null })}
                  onKeyDown={isFree ? undefined : (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setTextTarget({ kind: tile.kind as ContextPartKind, itemId: tile.item?.id ?? null });
                  }}
                >
                  {bare ? null : <span className="yuri-ctx-tile-n">{name}</span>}
                  {bare || low ? null : <span className="yuri-ctx-tile-v">{value}</span>}
                </div>
              );
            }) : null}
          </div>
        ) : (
          <div
            role="img"
            aria-label={`${formatCompactTokens(used)}${limit ? ` / ${formatCompactTokens(limit)}` : ''}`}
            className={cn('yuri-ctx-grid', narrow && 'is-narrow')}
            onPointerLeave={clearFocus}
          >
            {cells.map((cell, index) => {
              if (!cell) {
                return (
                  <i
                    key={index}
                    className={cn('yuri-ctx-cell is-free', focus !== null && !(focus.type === 'part' && focus.kind === 'free') && 'is-dim')}
                    onPointerEnter={() => setFocus({ type: 'part', kind: 'free' })}
                  />
                );
              }
              const item = parts.find((part) => part.kind === cell.kind)?.items[cell.item] ?? null;
              const dimmed = focus !== null && (
                focus.type === 'part' ? focus.kind !== cell.kind
                  : focus.type === 'item' ? !(focus.kind === cell.kind && focus.id === item?.id)
                    : true
              );
              return (
                <button
                  key={index}
                  type="button"
                  aria-label={partLabel(t, cell.kind)}
                  className={cn('yuri-ctx-cell', `yuri-ctx-k-${cell.kind}`, dimmed && 'is-dim', !dimmed && focus?.type === 'item' && 'is-on')}
                  onPointerEnter={() => setFocus(item ? { type: 'item', kind: cell.kind, id: item.id } : { type: 'part', kind: cell.kind })}
                  onClick={() => setTextTarget({ kind: cell.kind, itemId: item?.id ?? null })}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="yuri-ctx-legend">
        {legend.map((entry) => {
          const content = (
            <>
              <i className={cn('yuri-ctx-dot', `yuri-ctx-k-${entry.kind}`, entry.kind === 'free' && 'is-free')} />
              <span>{entry.label}</span>
              <span className="v">{formatCompactTokens(entry.tokens)}</span>
            </>
          );
          return entry.kind === 'free' ? (
            <span
              key={entry.kind}
              className="yuri-ctx-leg is-static"
              onPointerEnter={() => setFocus({ type: 'part', kind: 'free' })}
              onPointerLeave={clearFocus}
            >
              {content}
            </span>
          ) : (
            <button
              key={entry.kind}
              type="button"
              className="yuri-ctx-leg"
              onPointerEnter={() => setFocus({ type: 'part', kind: entry.kind as ContextPartKind })}
              onPointerLeave={clearFocus}
              onClick={() => setTextTarget({ kind: entry.kind as ContextPartKind, itemId: null })}
            >
              {content}
            </button>
          );
        })}
        <span className="yuri-ctx-look" role="group">
          {([['map', 'contextSidebar.window.look.map', LOOK_MAP], ['grid', 'contextSidebar.window.look.grid', LOOK_GRID]] as const).map(([id, key, icon]) => (
            <button
              key={id}
              type="button"
              className="yuri-ctx-look-b"
              title={t(key)}
              aria-label={t(key)}
              aria-pressed={look === id}
              onClick={() => { clearFocus(); setStoredLook(id); }}
            >
              {icon}
            </button>
          ))}
        </span>
      </div>

      <div className="yuri-ctx-contents">
        <div className="yuri-ctx-contents-head">
          <span className="yuri-ctx-label">{t('contextSidebar.window.contents')}</span>
          <span className="yuri-ctx-tabs" role="group">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="yuri-ctx-tab"
                aria-pressed={activeTab === entry.id}
                onClick={() => { setTab(entry.id); setExpandedRows(false); }}
              >
                {entry.label}
              </button>
            ))}
          </span>
        </div>
        <div className="yuri-ctx-rows">
          {visibleRows.map(({ item, kind }) => {
            const tag = itemTag(item);
            return (
              <button
                key={item.id}
                type="button"
                className={cn('yuri-ctx-row', `yuri-ctx-k-${kind}`, focus?.type === 'item' && focus.id === item.id && 'is-on')}
                onPointerEnter={() => setFocus({ type: 'item', kind, id: item.id })}
                onPointerLeave={clearFocus}
                onClick={() => setTextTarget({ kind, itemId: item.id })}
              >
                <i className="yuri-ctx-dot" />
                <ContextItemLabel item={item} />
                {item.count > 1 && item.kind !== 'turn' ? <span className="yuri-ctx-x">×{item.count}</span> : null}
                {tag ? <code className="yuri-ctx-tag">{tag}</code> : null}
                <span className="yuri-ctx-mini"><i style={{ width: `${Math.max(2, (item.tokens / mostTokens) * 100).toFixed(1)}%` }} /></span>
                <span className="yuri-ctx-v">{formatCompactTokens(item.tokens)}</span>
              </button>
            );
          })}
        </div>
        {rows.length > ROWS_COLLAPSED ? (
          <button type="button" className="yuri-ctx-more" onClick={() => setExpandedRows((current) => !current)}>
            {expandedRows ? t('contextSidebar.window.showFewer') : t('contextSidebar.window.showAll', { count: rows.length })}
          </button>
        ) : null}
      </div>

      {requestTotals.length > 1 ? (
        <div className="yuri-ctx-session">
          <span className="yuri-ctx-label">{t('contextSidebar.window.session')}</span>
          <Spark series={requestTotals} limit={limit} />
          <span className="yuri-ctx-sub">
            {requestTotals.length === 1
              ? t('contextSidebar.window.requests.one')
              : t('contextSidebar.window.requests.other', { count: requestTotals.length })}
          </span>
        </div>
      ) : null}

      <div className="yuri-ctx-note">{t('contextSidebar.window.estimateNote')}</div>

      <ContextTextDialog target={textTarget} parts={parts} onClose={() => setTextTarget(null)} />
    </div>
  );
};
