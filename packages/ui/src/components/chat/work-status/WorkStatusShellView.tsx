import React from 'react';
import { useEvent } from '@reactuses/core';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import {
  workStatusShellInfoQueryOptions,
  type WorkStatusShell,
} from './workStatusShells';

function useShellCommand(shell: WorkStatusShell): string | undefined {
  return useQuery(workStatusShellInfoQueryOptions(shell.directory, shell.id)).data?.command;
}

export const WorkStatusShellRow = React.memo(function WorkStatusShellRow({ shell, onOpen }: {
  shell: WorkStatusShell;
  onOpen: (shell: WorkStatusShell, command: string) => void;
}) {
  const { t } = useI18n();
  const command = useShellCommand(shell) ?? t('chat.workStatus.shell.untitled');
  const open = useEvent(() => onOpen(shell, command));
  return (
    <Button
      variant="ghost"
      size="sm"
      className="yuri-work-status-action flex w-full min-w-0 items-center justify-start gap-2 text-left text-[12px] font-normal leading-5 text-muted-foreground"
      onClick={open}
    >
      <Icon name="terminal" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono" title={command}>{command}</span>
    </Button>
  );
});
