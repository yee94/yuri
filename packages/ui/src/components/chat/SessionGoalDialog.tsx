import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { clearSessionGoal, setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { useI18n } from '@/lib/i18n';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useUIStore } from '@/stores/useUIStore';

interface SessionGoalDialogProps { open: boolean; onOpenChange: (open: boolean) => void; sessionId: string; directory?: string }

export function SessionGoalDialog({ open, onOpenChange, sessionId, directory }: SessionGoalDialogProps) {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const { goal, error } = useSessionGoal(sessionId, directory);
  const [busy, setBusy] = React.useState(false);
  const run = useEvent(async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); onOpenChange(false); }
    catch { toast.error(t('chat.goal.toast.actionFailed')); }
    finally { setBusy(false); }
  });
  const title = t('chat.goal.dialog.titleManage');
  const body = <div className="space-y-3">
    {error && <p role="alert" className="typography-meta text-muted-foreground">{t('chat.goal.toast.actionFailed')}</p>}
    {goal && <>
      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words typography-ui-label">{goal.objective}</p>
      <p className="typography-meta text-muted-foreground">{t(sessionGoalStatusLabelKey[goal.status] as never)} · {goal.rounds}/{goal.maxRounds}</p>
      {goal.reason && <p className="typography-meta text-muted-foreground">{goal.reason}</p>}
      <div className="flex justify-end gap-2">
        {goal.status !== 'complete' && <Button size="sm" disabled={busy} onClick={() => void run(() => setSessionGoalStatus(sessionId, directory, goal.status === 'active' ? 'paused' : 'active'))}>
          {t(goal.status === 'active' ? 'chat.goal.action.pause' : 'chat.goal.action.resume')}
        </Button>}
        <Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(() => clearSessionGoal(sessionId, directory))}>{t('chat.goal.action.clear')}</Button>
      </div>
    </>}
  </div>;
  if (isMobile) return <MobileOverlayPanel open={open} title={title} onClose={() => onOpenChange(false)}>{body}</MobileOverlayPanel>;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>{body}</DialogContent></Dialog>;
}
