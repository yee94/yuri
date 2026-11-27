import React from 'react';
import { useEvent } from '@reactuses/core';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { navigateNestedSession, useSessionSurface } from '@/components/chat/SessionSurfaceContext';
import { useWorkStatusShells } from '@/components/chat/work-status/useWorkStatusShells';
import { useWorkStatusSubagents } from '@/components/chat/work-status/useWorkStatusSubagents';
import { useShellCommand } from '@/components/chat/work-status/WorkStatusShellView';
import type { WorkStatusShell } from '@/components/chat/work-status/workStatusShells';
import type { WorkStatusSubagent } from '@/components/chat/work-status/workStatusSubagents';
import { Icon } from '@/components/icon/Icon';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { pushPhoneNestedSession } from '../useMobileNavigationStore';

const MAX_BAR_FACES = 4;
const BAR_FACE_SIZE = 24;
const ROW_FACE_SIZE = 28;

const SubagentRow: React.FC<{ subagent: WorkStatusSubagent; onOpen: (sessionId: string) => void }> = ({ subagent, onOpen }) => {
  const { t } = useI18n();
  const label = subagent.label.trim() || t('chat.workStatus.subagent.untitled');
  const content = (
    <>
      <AgentAvatar name={subagent.seed} label={label} size={ROW_FACE_SIZE} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left text-sm text-foreground">{label}</span>
      {subagent.sessionID ? <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" /> : null}
    </>
  );
  if (!subagent.sessionID) return <div className="flex min-h-12 items-center gap-3 px-4">{content}</div>;
  const sessionId = subagent.sessionID;
  return (
    <button
      type="button"
      className="flex min-h-12 w-full items-center gap-3 px-4 active:bg-interactive-active"
      onClick={() => onOpen(sessionId)}
    >
      {content}
    </button>
  );
};

const ShellRow: React.FC<{ shell: WorkStatusShell }> = ({ shell }) => {
  const { t } = useI18n();
  const command = useShellCommand(shell) ?? t('chat.workStatus.shell.untitled');
  return (
    <div className="flex min-h-12 items-center gap-3 px-4">
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground"
        style={{ width: ROW_FACE_SIZE, height: ROW_FACE_SIZE }}
        aria-hidden="true"
      >
        <Icon name="terminal" className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground" title={command}>{command}</span>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section aria-label={title} className="flex flex-col [&+section]:mt-2">
    <div className="px-4 pb-1 pt-3 text-xs text-muted-foreground">{title}</div>
    {children}
  </section>
);

type Props = { sessionId: string | null; directory: string | null; className?: string };

export const MobileBackgroundWorkBar: React.FC<Props> = React.memo(function MobileBackgroundWorkBar({ sessionId, directory, className }) {
  const { t } = useI18n();
  const allSubagents = useWorkStatusSubagents(sessionId, directory);
  const shells = useWorkStatusShells(sessionId, directory);
  const subagents = React.useMemo(() => allSubagents.filter((agent) => agent.phase === 'working'), [allSubagents]);
  const [open, setOpen] = React.useState(false);
  const sessionSurface = useSessionSurface();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);

  const openSession = useEvent((childId: string) => {
    if (!directory) return;
    setOpen(false);
    navigateNestedSession(sessionSurface, childId, directory, () => {
      if (pushPhoneNestedSession({ sessionId: childId, directory })) return;
      setCurrentSession(childId, directory);
    });
  });

  const total = subagents.length + shells.length;
  if (!sessionId || total === 0) return null;
  const label = t('chat.sessionBackground.tasksRunning', { count: total });
  const shownSubagents = subagents.slice(0, MAX_BAR_FACES);
  const showShellFace = shells.length > 0 && shownSubagents.length < MAX_BAR_FACES;

  return (
    <div className={cn('relative z-10 flex justify-center pb-2', className)} data-component="mobile-background-work-bar">
      <button
        type="button"
        aria-label={label}
        className="flex items-center rounded-full border border-border bg-secondary px-2.5 py-1.5 shadow-sm active:bg-interactive-active"
        onClick={() => setOpen(true)}
      >
        <span className="flex items-center -space-x-1.5">
          {shownSubagents.map((subagent) => (
            <AgentAvatar
              key={subagent.key}
              name={subagent.seed}
              size={BAR_FACE_SIZE}
              className="relative bg-secondary ring-2 ring-secondary"
            />
          ))}
          {showShellFace ? (
            <span
              className="relative inline-flex shrink-0 items-center justify-center rounded-sm bg-muted text-foreground ring-2 ring-secondary"
              style={{ width: BAR_FACE_SIZE, height: BAR_FACE_SIZE }}
              aria-hidden="true"
            >
              <Icon name="terminal" className="size-3.5" />
            </span>
          ) : null}
        </span>
      </button>
      <MobileResizableSheet
        id="mobile-background-work"
        open={open}
        onOpenChange={setOpen}
        title={<span className="text-sm font-medium text-foreground">{label}</span>}
        ariaLabel={label}
        closeAriaLabel={t('mobile.surface.closeAria')}
        resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
        fitContent
        bodyClassName="overflow-y-auto pb-[max(env(safe-area-inset-bottom),1rem)]"
      >
        {subagents.length > 0 ? (
          <Section title={t('chat.workStatus.section.subagents')}>
            {subagents.map((subagent) => <SubagentRow key={subagent.key} subagent={subagent} onOpen={openSession} />)}
          </Section>
        ) : null}
        {shells.length > 0 ? (
          <Section title={t('chat.workStatus.section.shells')}>
            {shells.map((shell) => <ShellRow key={shell.id} shell={shell} />)}
          </Section>
        ) : null}
      </MobileResizableSheet>
    </div>
  );
});
