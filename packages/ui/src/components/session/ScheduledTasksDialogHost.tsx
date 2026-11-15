import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { parseRoute } from '@/lib/router';
import { useUIStore } from '@/stores/useUIStore';

const ScheduledTasksDialog = lazyWithChunkRecovery(() => import('./ScheduledTasksDialog').then(m => ({ default: m.ScheduledTasksDialog })));

/** Route restoration stays mounted; editor code loads only on first open. */
export function ScheduledTasksDialogHost() {
  const open = useUIStore(state => state.isScheduledTasksDialogOpen);
  const setOpen = useUIStore(state => state.setScheduledTasksDialogOpen);
  const isMobile = useUIStore(state => state.isMobile);
  const [visited, setVisited] = React.useState(open && isMobile);
  if (open && isMobile && !visited) setVisited(true);
  React.useEffect(() => {
    if (!isMobile) return;
    const restoreTaskRoute = (event?: PopStateEvent) => {
      const route = parseRoute();
      if (route.tab === 'schedule' && route.scheduleProjectId && route.scheduleTaskId) setOpen(true);
      else if (event && route.tab !== 'schedule') setOpen(false);
    };
    restoreTaskRoute();
    window.addEventListener('popstate', restoreTaskRoute);
    return () => window.removeEventListener('popstate', restoreTaskRoute);
  }, [isMobile, setOpen]);
  return visited && isMobile ? <React.Suspense fallback={null}><ScheduledTasksDialog /></React.Suspense> : null;
}
