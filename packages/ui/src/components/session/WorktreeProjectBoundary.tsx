import type { ReactNode } from 'react';
import { HostRuntimeProvider, useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { HostRuntimeContext } from '@/contexts/hostRuntimeContext';
import { useRemoteProjectRuntime, ensureRemoteHostCatalog } from '@/queries/remoteProjectQueries';
import type { ProjectEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

/** Explicit dialog project wins over a retained workspace's Host/cwd. */
export function WorktreeProjectBoundary({ project, open, onClose, children }: { project: ProjectEntry | null; open: boolean; onClose(): void; children: ReactNode }) {
  const parent = useHostRuntime();
  const matching = project?.hostId && parent && parent.entry.location.hubId === project.hubId && parent.entry.location.hostId === project.hostId && parent.entry.location.directory === project.path;
  const runtime = useRemoteProjectRuntime(Boolean(open && project?.hostId && !matching));
  const { t } = useI18n();
  if (!project?.hostId) return <HostRuntimeContext.Provider value={null}>{children}</HostRuntimeContext.Provider>;
  if (matching) return children;
  if (!open) return null;
  if (!runtime.registry || runtime.registry.hubId !== project.hubId) return <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t('session.newWorktree.title')}</DialogTitle></DialogHeader>
    <p role={runtime.isPending ? 'status' : 'alert'}>{runtime.isPending ? t('remoteProjects.running') : runtime.error?.message || t('remoteProjects.host-unavailable')}</p>
    <DialogFooter><Button onClick={onClose}>{t('session.newWorktree.actions.cancel')}</Button>{!runtime.isPending ? <Button onClick={() => { void ensureRemoteHostCatalog().catch(() => {}); }}>{t('remoteProjects.retry')}</Button> : null}</DialogFooter>
  </DialogContent></Dialog>;
  return <HostRuntimeProvider registry={runtime.registry} location={{ hubId: project.hubId!, hostId: project.hostId, directory: project.path }}>{children}</HostRuntimeProvider>;
}
