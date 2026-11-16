import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { TerminalViewport } from './TerminalViewport';
import { shellLogQueryOptions } from '@/queries/shellLogQueries';
import type { TerminalTab } from '@/stores/useTerminalStore';
import type { TerminalTheme } from '@/lib/terminalTheme';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

const ignore = () => {};
const EMPTY_CHUNKS: [] = [];

export function ShellLogViewport({ shell, theme, fontFamily, fontSize }: {
  shell: NonNullable<TerminalTab['shellLog']>;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const current = shell.transport === getRuntimeTransportIdentity();
  const options = shellLogQueryOptions(shell, client);
  const log = useQuery({ ...options, enabled: current });
  const [stopping, setStopping] = React.useState(false);
  const stop = useEvent(async () => {
    if (!current || stopping) return;
    setStopping(true);
    try {
      await opencodeClient.getScopedSdkClient(shell.directory).shell.remove({
        id: shell.id, location: { directory: shell.directory },
      });
      await client.invalidateQueries({ queryKey: options.queryKey });
    } catch {
      toast.error(t('chat.workStatus.shell.stopFailed'));
    } finally {
      setStopping(false);
    }
  });
  return <div className="flex h-full min-h-0 flex-col" data-shell-log={shell.id}>
    <div className="flex shrink-0 items-center gap-2 px-4 py-1 text-xs text-muted-foreground">
      <Icon name="lock" className="size-3.5" />
      <span>{t('chat.workStatus.shell.readOnly')}</span>
      {log.data && log.data.status !== 'running' ? <span role="status">{t('chat.workStatus.shell.exited')}</span> : null}
      {!current || log.isError ? <span role="alert">{t('chat.workStatus.shell.outputUnavailable')}</span> : null}
      {current && log.data?.status === 'running' ? <Button variant="ghost" size="xs" className="ml-auto" disabled={stopping} onClick={() => void stop()}>
        <Icon name="stop-circle" className="size-3.5" />{t('chat.workStatus.shell.stop')}
      </Button> : null}
    </div>
    <div className="min-h-0 flex-1 px-4 pb-2">
      <TerminalViewport sessionKey={`${shell.transport}:${shell.id}`} chunks={log.data?.chunks ?? EMPTY_CHUNKS}
        onInput={ignore} onResize={ignore} theme={theme} fontFamily={fontFamily} fontSize={fontSize}
        readOnly autoFocus={false} />
    </div>
  </div>;
}
