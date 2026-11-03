import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { MiniChatWindowHeader } from './MiniChatWindowHeader';
import { AssistantConversationSurface } from '@/components/assistants/AssistantConversationSurface';
import { AssistantCardNavigation } from '@/components/assistants/AssistantCardNavigation';
import { AssistantWorkingAvatar } from '@/components/assistants/AssistantWorkingAvatar';
import { AssistantContactStatus } from '@/components/assistants/AssistantContactStatus';
import { getAssistantPresentation } from '@/components/assistants/assistantPresentation';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { invokeDesktop } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useAssistantCapabilityQuery, useAssistantSnapshotQuery } from '@/queries/assistantQueries';
import { useConfigStore } from '@/stores/useConfigStore';

export const AssistantMiniChatLayout: React.FC<{ assistantID: string }> = ({ assistantID }) => {
  const { t } = useI18n();
  const capability = useAssistantCapabilityQuery();
  const snapshot = useAssistantSnapshotQuery();
  const assistant = snapshot.data?.assistants.find((item) => item.id === assistantID);
  const initializeApp = useConfigStore((state) => state.initializeApp);
  React.useEffect(() => { void initializeApp(); }, [initializeApp]);
  const title = assistant ? getAssistantPresentation(assistant.name).displayName || assistant.name : t('assistants.title');
  React.useEffect(() => {
    document.title = `${title} — Yuri`;
  }, [title]);
  const navigateCard = useEvent<NonNullable<React.ContextType<typeof AssistantCardNavigation>>>((target) => {
    void invokeDesktop('desktop_focus_main_window', target).catch(() => toast.error(t('miniChat.actions.failed')));
  });
  const retry = useEvent(() => { void capability.refetch(); void snapshot.refetch(); });
  const loading = capability.isPending || snapshot.isPending;
  const available = capability.data?.supported && capability.data.enabled && snapshot.data?.enabled && assistant;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-clip bg-background text-foreground">
      <MiniChatWindowHeader mainWindowTarget={{ assistantID }}>
        <div className="flex min-w-0 items-center gap-2.5">
          {assistant ? <AssistantWorkingAvatar name={assistant.id} avatarSeed={assistant.avatarSeed} size={32} label={title} working={Boolean(assistant.working || assistant.activeContactTurn)} showWorkingDot={false} /> : null}
          <div className="min-w-0">
            <div className="truncate typography-ui-label text-[14px] leading-tight" title={title}>{title}</div>
            {assistant ? <AssistantContactStatus assistantID={assistant.id} serverWorking={Boolean(assistant.working || assistant.activeContactTurn)} lastContactAt={assistant.latestMessagePreview?.createdAt} /> : null}
          </div>
        </div>
      </MiniChatWindowHeader>
      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy="true" aria-label={t('common.loading')}><Icon name="loader-4" className="size-6 animate-spin text-muted-foreground" /></div>
      ) : available ? (
        <AssistantCardNavigation.Provider value={navigateCard}>
          <AssistantConversationSurface assistant={assistant} active warning={snapshot.isError ? t('assistants.state.staleSnapshot') : null} />
        </AssistantCardNavigation.Provider>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-muted-foreground">
          <p>{t('assistants.state.unavailable')}</p>
          {capability.isError || snapshot.isError ? <Button onClick={retry}>{t('startup.initRecovery.retry')}</Button> : null}
        </div>
      )}
    </div>
  );
};
