import { createContext } from 'react';

export const SessionRowDragContext = createContext(false);

/** True while a drag-to-reorder is active and briefly after it ends; rows must not animate their own reorder then. */
export const SessionListReorderLockContext = createContext(false);
