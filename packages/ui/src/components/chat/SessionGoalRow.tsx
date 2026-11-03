import React from 'react';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SessionGoalDialog } from './SessionGoalDialog';

interface SessionGoalRowProps { sessionId: string | null; directory?: string; className?: string }

export const SessionGoalRow: React.FC<SessionGoalRowProps> = React.memo(({ sessionId, directory, className }) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const toggle = useEvent(async () => {
    if (!sessionId || !goal || busy || goal.status === 'complete') return;
    setBusy(true);
    try { await setSessionGoalStatus(sessionId, directory, goal.status === 'active' ? 'paused' : 'active'); }
    catch { toast.error(t('chat.goal.toast.actionFailed')); }
    finally { setBusy(false); }
  });
  if (!sessionId || !goal || !enabled) return null;
  return (
    <div className={cn('flex w-full min-w-0 items-center gap-1.5 py-0.5', className)} aria-label={t('chat.goal.row.aria')}>
      <Icon name="target" className="size-3.5 shrink-0" style={{ color: sessionGoalStatusColor[goal.status] }} aria-hidden="true" />
      <button type="button" className="min-w-0 flex-1 truncate text-left typography-ui-label" onClick={() => setOpen(true)} title={goal.objective}>
        {goal.objective}
      </button>
      <span className="shrink-0 typography-meta text-muted-foreground">{t(sessionGoalStatusLabelKey[goal.status] as never)}</span>
      <span className="shrink-0 typography-meta tabular-nums text-muted-foreground">{goal.rounds}/{goal.maxRounds}</span>
      {goal.status !== 'complete' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggle()}>
        <Icon name={goal.status === 'active' ? 'pause' : 'play'} className="size-3.5" aria-hidden="true" />
        {t(goal.status === 'active' ? 'chat.goal.action.pause' : 'chat.goal.action.resume')}
      </Button>}
      <SessionGoalDialog open={open} onOpenChange={setOpen} sessionId={sessionId} directory={directory} />
    </div>
  );
});
SessionGoalRow.displayName = 'SessionGoalRow';
