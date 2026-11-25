import React from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type Variants } from 'motion/react';

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

type RowsMode = { animate: boolean; animateEnter: boolean };

const STATIC_MODE: RowsMode = { animate: false, animateEnter: false };
const RowsModeContext = React.createContext<RowsMode>(STATIC_MODE);

/**
 * Presence scope for rows wrapped in `SidebarAnimatedRow`. Rows already mounted
 * never animate in. A commit that adds more than MAX_ANIMATED_ROW_CHANGES rows
 * mounts them without the per-row height measurement, and one that removes more
 * than that drops them at once instead of collapsing each; smaller changes animate.
 */
export function SidebarAnimatedRows({ children }: { children: React.ReactNode }): React.ReactNode {
  const reduceMotion = useReducedMotion();
  const previousKeys = React.useRef<ReadonlySet<React.Key>>(new Set());
  const keys: React.Key[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.key != null) keys.push(child.key);
  });
  let added = 0;
  for (const key of keys) if (!previousKeys.current.has(key)) added += 1;
  const removed = previousKeys.current.size - (keys.length - added);
  const animateEnter = previousKeys.current.size > 0 && added <= MAX_ANIMATED_ROW_CHANGES;
  const bulkExit = removed > MAX_ANIMATED_ROW_CHANGES;
  React.useLayoutEffect(() => {
    previousKeys.current = new Set(keys);
  });
  const mode = React.useMemo<RowsMode>(
    () => (reduceMotion ? STATIC_MODE : { animate: true, animateEnter }),
    [animateEnter, reduceMotion],
  );
  return (
    <RowsModeContext.Provider value={mode}>
      <AnimatePresence initial={false} custom={bulkExit}>{children}</AnimatePresence>
    </RowsModeContext.Provider>
  );
}

/**
 * Collapses a row's height and fades it in/out so siblings slide into the gap.
 * Overflow is clipped only while the height animates, so focus rings stay visible at rest.
 */
export function SidebarAnimatedRow({ children }: { children: React.ReactNode }): React.ReactNode {
  const mode = React.useContext(RowsModeContext);
  // A removed row stays mounted for its exit; it must not take clicks or focus meanwhile.
  const present = useIsPresent();
  if (!mode.animate) return <div>{children}</div>;
  return (
    <motion.div
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
