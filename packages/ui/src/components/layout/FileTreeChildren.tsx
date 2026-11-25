import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

const CHILDREN_TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

/**
 * True only when the expanded-directory count moved by at most one since the
 * last commit. Expand-all, collapse-all and restored tab state change many
 * directories at once and must not start one animation per directory.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Both file trees share this hook with the component.
export function useSingleToggleExpansion(expandedCount: number): boolean {
  const previous = React.useRef(expandedCount);
  const singleToggle = Math.abs(expandedCount - previous.current) <= 1;
  React.useLayoutEffect(() => {
    previous.current = expandedCount;
  });
  return singleToggle;
}

type FileTreeChildrenProps = {
  expanded: boolean;
  animate: boolean;
  className: string;
  children: React.ReactNode;
};

/**
 * One animated child list per directory (not per row). The presence scope mounts
 * together with its directory row, so a subtree revealed by an ancestor never
 * animates; only the directly toggled directory does.
 */
export function FileTreeChildren({ expanded, animate, className, children }: FileTreeChildrenProps): React.ReactNode {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return expanded ? <ul className={className}>{children}</ul> : null;
  return (
    <AnimatePresence initial={false}>
      {expanded ? (
        <motion.ul
          key="children"
          className={className}
          initial={animate ? { opacity: 0, height: 0, overflow: 'hidden' } : false}
          animate={{ opacity: 1, height: 'auto', transitionEnd: { overflow: 'visible' } }}
          exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
          transition={CHILDREN_TRANSITION}
        >
          {children}
        </motion.ul>
      ) : null}
    </AnimatePresence>
  );
}
