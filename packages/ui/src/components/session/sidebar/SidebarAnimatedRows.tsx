import React from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type Variants } from 'motion/react';
import { SessionListReorderLockContext } from './sessionDragState';

const ROW_TRANSITION = { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const };

/** A session row's vertical margin (`my-0.5`); between rows it collapses to one 2px gap. */
const ROW_MARGIN_PX = 2;

/**
 * `clip` keeps the row's top margin collapsing through the wrapper while it animates,
 * exactly as at rest. `hidden` would start a formatting context that holds both margins
 * and shifts the row by its margin when an animation starts and ends (Safari 15 fallback).
 */
const ROW_CLIP = typeof CSS !== 'undefined' && CSS.supports?.('overflow', 'clip') ? 'clip' : 'hidden';

// The wrapper repeats the row's bottom margin, so a clipped (fixed-height) wrapper keeps the
// same gap below it. At zero height the negative top margin cancels the gap above it, so the
// collapsed row takes exactly the space of no row and unmounting does not move its neighbours.
const ROW_STYLE = { marginBottom: ROW_MARGIN_PX };
const COLLAPSED_ROW = { opacity: 0, height: 0, marginTop: -ROW_MARGIN_PX, overflow: ROW_CLIP };
const EXPANDED_ROW = { opacity: 1, height: 'auto', marginTop: 0, transitionEnd: { overflow: 'visible' } };

// An exiting row no longer receives props; AnimatePresence `custom` tells it whether it left in bulk.
const ROW_VARIANTS: Variants = {
  collapsed: COLLAPSED_ROW,
  expanded: EXPANDED_ROW,
  exit: (bulk: boolean) => (bulk ? { ...COLLAPSED_ROW, transition: { duration: 0 } } : COLLAPSED_ROW),
};

// Any `onUpdate` keeps opacity on motion's frameloop instead of WAAPI. A WAAPI fade is
// timed from the commit, so it runs out inside the long frame that commits a session
// switch, while the height collapse (always frameloop) only starts after that frame.
const KEEP_FADE_ON_FRAMELOOP = () => {};

/**
 * A commit that adds or removes more rows than this is paging, a filter or a fold
 * (search, "show more" / "show fewer", refresh), not a single user action.
 */
const MAX_ANIMATED_ROW_CHANGES = 3;

/**
 * A list rendered from a deferred copy (`useDeferredValue`) still holds rows the live
 * list already dropped. Rows that will animate out leave in the same commit as the
 * action that removed them (archive, delete) rather than after the deferred render,
 * which navigation and transcript loading keep interrupting. Bulk removals exit
 * instantly anyway, so they stay on the deferred lane.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Shares the bulk threshold with the presence scope.
export function withoutRemovedRows<T extends { id: string }>(deferred: T[], current: readonly T[]): T[] {
  if (deferred === current) return deferred;
  const currentIds = new Set<string>();
  for (const item of current) currentIds.add(item.id);
  let removed = 0;
  for (const item of deferred) {
    if (!currentIds.has(item.id) && ++removed > MAX_ANIMATED_ROW_CHANGES) return deferred;
  }
  return removed === 0 ? deferred : deferred.filter((item) => currentIds.has(item.id));
}

// Bulk sorts would start too many animations in the same frame.
const MAX_REORDER_ANIMATED_ROWS = 300;
const MAX_ANIMATED_REORDER_CHANGES = 24;
const REORDER_SLIDE_PX = 12;

type ReorderCue = { offset: number };
type AnimatedRowProps = { children: React.ReactNode; reorder?: ReorderCue };

type RowsMode = { animate: boolean; animateEnter: boolean; animateReorder: boolean };

const STATIC_MODE: RowsMode = { animate: false, animateEnter: false, animateReorder: false };
const RowsModeContext = React.createContext<RowsMode>(STATIC_MODE);

/**
 * Presence scope for rows wrapped in `SidebarAnimatedRow`. Rows already mounted
 * never animate in. A commit that adds more than MAX_ANIMATED_ROW_CHANGES rows
 * mounts them without the per-row height measurement, and one that removes more
 * than that drops them at once instead of collapsing each; smaller changes animate.
 */
export function SidebarAnimatedRows({ children }: { children: React.ReactNode }): React.ReactNode {
  const reduceMotion = useReducedMotion();
  const reorderLocked = React.useContext(SessionListReorderLockContext);
  const previousPositions = React.useRef<ReadonlyMap<React.Key, number>>(new Map());
  const previous = previousPositions.current;
  const positions = new Map<React.Key, number>();
  let added = 0;
  let moved = 0;
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child) || child.key == null) return;
    const oldIndex = previous.get(child.key);
    if (oldIndex === undefined) added += 1;
    else if (oldIndex !== positions.size) moved += 1;
    positions.set(child.key, positions.size);
  });
  const removed = previous.size - (positions.size - added);
  const animateEnter = previous.size > 0 && added <= MAX_ANIMATED_ROW_CHANGES;
  const bulkExit = removed > MAX_ANIMATED_ROW_CHANGES;
  React.useLayoutEffect(() => {
    previousPositions.current = positions;
  });
  // Presence already moves the neighbours of added/removed rows by animating height.
  const animateReorder = !reorderLocked && added === 0 && removed === 0
    && positions.size <= MAX_REORDER_ANIMATED_ROWS && moved <= MAX_ANIMATED_REORDER_CHANGES;
  const mode = React.useMemo<RowsMode>(
    () => (reduceMotion ? STATIC_MODE : { animate: true, animateEnter, animateReorder }),
    [animateEnter, animateReorder, reduceMotion],
  );
  let rows = children;
  if (mode.animate && animateReorder && moved > 0) {
    const reorderedRows: React.ReactNode[] = [];
    // Keep the original keys: Children.map would prefix them only on reorder commits.
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<AnimatedRowProps>(child) || child.type !== SidebarAnimatedRow || child.key == null) {
        reorderedRows.push(child);
        return;
      }
      const previousIndex = previous.get(child.key);
      const currentIndex = positions.get(child.key);
      if (previousIndex === undefined || currentIndex === undefined || previousIndex === currentIndex) {
        reorderedRows.push(child);
      } else {
        const offset = previousIndex < currentIndex ? -REORDER_SLIDE_PX : REORDER_SLIDE_PX;
        reorderedRows.push(React.cloneElement(child, { reorder: { offset } }));
      }
    });
    rows = reorderedRows;
  }
  return (
    <RowsModeContext.Provider value={mode}>
      <AnimatePresence initial={false} custom={bulkExit}>{rows}</AnimatePresence>
    </RowsModeContext.Provider>
  );
}

/**
 * Collapses a row's height and fades it in/out so siblings slide into the gap.
 * Overflow is clipped only while the height animates, so focus rings stay visible at rest.
 */
export function SidebarAnimatedRow({ children, reorder }: AnimatedRowProps): React.ReactNode {
  const mode = React.useContext(RowsModeContext);
  // A removed row stays mounted for its exit; it must not take clicks or focus meanwhile.
  const present = useIsPresent();
  const row = React.useRef<HTMLDivElement>(null);
  const animation = React.useRef<Animation | undefined>(undefined);
  const canReorder = mode.animate && mode.animateReorder && present;
  React.useLayoutEffect(() => {
    if (!canReorder || reorder) {
      animation.current?.cancel();
      animation.current = undefined;
    }
    if (!canReorder || !reorder) return;
    const { offset } = reorder;
    // Clip the translated edge by the same amount so adjacent rows never cross visually.
    const clipPath = offset < 0 ? `inset(${-offset}px 0 0)` : `inset(0 0 ${offset}px)`;
    animation.current = row.current?.animate?.([
      { transform: `translateY(${offset}px)`, clipPath },
      { transform: 'translateY(0px)', clipPath: 'inset(0px)' },
    ], {
      duration: ROW_TRANSITION.duration * 1000,
      easing: `cubic-bezier(${ROW_TRANSITION.ease.join(',')})`,
      fill: 'backwards',
    });
  }, [canReorder, reorder]);
  React.useLayoutEffect(() => () => animation.current?.cancel(), []);
  if (!mode.animate) return <div>{children}</div>;
  return (
    <motion.div
      ref={row}
      style={ROW_STYLE}
      variants={ROW_VARIANTS}
      initial={mode.animateEnter ? 'collapsed' : false}
      animate="expanded"
      exit="exit"
      transition={ROW_TRANSITION}
      onUpdate={KEEP_FADE_ON_FRAMELOOP}
      inert={!present || undefined}
    >
      {children}
    </motion.div>
  );
}
