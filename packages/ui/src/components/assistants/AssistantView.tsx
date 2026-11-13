import { partitionAssistantContacts } from './sortAssistantContacts';
import { AssistantContactMenu } from './AssistantContactMenu';
import { AssistantPinnedContacts } from './AssistantPinnedContacts';
import React from 'react';
import { AssistantUnreadBadge } from './AssistantUnreadBadge';
import { AssistantMarkAllReadButton } from './AssistantMarkAllReadButton';
import { useEvent } from '@reactuses/core';
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar';
import { useAssistantWorking } from './assistantWorking';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useAssistantCapabilityQuery, useAssistantSnapshotQuery, type AssistantDTO } from '@/queries/assistantQueries';
import { openAssistantSettings, useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useUIStore } from '@/stores/useUIStore';
import { AssistantConversationSurface } from './AssistantConversationSurface';
import { AssistantDeleteConfirmDialog } from './AssistantDeleteConfirmDialog';
import { getAssistantPresentation } from './assistantPresentation';
import { ASSISTANT_MESSAGE_PREVIEW_CLASS, getAssistantMessagePreview } from './assistantMessagePreview';
import { resolveAssistantWorkspacePresentation } from './assistantWorkspaceState';

type MobileAssistantConversationHeaderProps = {
  assistant?: Pick<AssistantDTO, 'id' | 'name' | 'avatarSeed' | 'assignedSessionIDs' | 'working' | 'activeContactTurn' | 'latestMessagePreview'> | null;
  onBack: () => void;
  onOpenSettings?: (assistantID: string) => void;
};

function AssistantHeaderIdentity({ assistant, onClick }: {
  assistant: NonNullable<MobileAssistantConversationHeaderProps['assistant']>;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const displayName = getAssistantPresentation(assistant.name).displayName || assistant.name;
  return (
    <Button type="button" variant="ghost" className="yuri-assistant-header-identity" onClick={onClick}
      aria-label={t('assistants.conversation.openSettings')} title={displayName}>
      <AssistantWorkingAvatar name={assistant.id} avatarSeed={assistant.avatarSeed} size={56} label={displayName}
        working={Boolean(assistant.working || assistant.activeContactTurn)} showWorkingDot={false} />
      <span className="yuri-assistant-header-name truncate typography-ui-label font-medium">{displayName}</span>
    </Button>
  );
}

const MobileAssistantConversationHeader: React.FC<MobileAssistantConversationHeaderProps> = ({ assistant, onBack, onOpenSettings }) => {
  const { t } = useI18n();
  const mobileActions = useMobileAppActions();
  const openSettings = useEvent(() => {
    if (!assistant) return;
    if (onOpenSettings) {
      onOpenSettings(assistant.id);
      return;
    }
    openAssistantSettings(assistant.id, mobileActions ? { openMobileSettings: mobileActions.openSettings } : undefined);
  });

  return (
    <MobileDetailNavigation
      className="yuri-assistant-mobile-header"
      title={assistant ? <AssistantHeaderIdentity assistant={assistant} onClick={openSettings} /> : t('assistants.title')}
      backAriaLabel={t('assistants.actions.backToChat')}
      onBack={onBack}
      overlay
    />
  );
};

type AssistantListItemProps = {
  assistant: AssistantDTO;
  avatarSeed?: string;
  unreadCount: number;
  summary: string;
  assistantID: string;
  displayName: string;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  assignedSessionIDs?: string[];
  serverWorking?: boolean;
};

const AssistantListItem: React.FC<AssistantListItemProps> = ({
  assistant,
  avatarSeed,
  unreadCount,
  summary,
  assistantID,
  displayName,
  selected,
  onSelect,
  onEdit,
  onDelete,
  // serverWorking is snapshot-authoritative; local store is temporary only.
  serverWorking = false,
}) => {
  const working = useAssistantWorking(assistantID, serverWorking);
  const hoverTarget = React.useRef<HTMLButtonElement>(null);
  const handleSelect = useEvent(() => onSelect());

  return (
    <AssistantContactMenu
      assistant={assistant}
      doubleClickMiniChat
      onEdit={onEdit}
      onDelete={onDelete}
      trigger={(
        <button
          ref={hoverTarget}
          type="button"
          role="option"
          aria-selected={selected}
          onClick={handleSelect}
          className={cn(
            'yuri-assistant-contact-row flex w-full min-h-11 items-center gap-3 rounded-xl border border-transparent px-3 py-3 text-left outline-none transition-[background-color,opacity] duration-150 ease-out active:bg-interactive-active focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] motion-reduce:transition-none',
            selected
              ? 'bg-interactive-selection text-interactive-selection-foreground'
              : 'hover:bg-interactive-hover',
          )}
        >
          <AssistantWorkingAvatar name={assistantID} avatarSeed={avatarSeed} size={44} label={displayName} working={working} hoverTarget={hoverTarget} />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate typography-ui-label leading-5', selected ? 'font-semibold' : 'font-medium')}>{displayName}</span>
            <span className={cn(ASSISTANT_MESSAGE_PREVIEW_CLASS, 'mt-1 text-[length:calc(var(--text-micro)*0.9)] leading-5')}>{summary}</span>
          </span>
          <AssistantUnreadBadge count={unreadCount} className="h-3.5 min-w-3.5 px-1 text-[10px]" />
        </button>
      )}
    />
  );
};

export type AssistantViewProps = {
  /** Dedicated mobile navigation owns whether this mounted detail page is active. */
  activeOverride?: boolean;
  /** When present, mobile renders a second-level conversation header with Back. */
  onMobileBack?: () => void;
  /** Phone stack owns the independent Settings detail above this conversation. */
  onMobileOpenSettings?: (assistantID: string) => void;
};

export const AssistantView: React.FC<AssistantViewProps> = ({ activeOverride, onMobileBack, onMobileOpenSettings }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const mobileActions = useMobileAppActions();
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const mainTabActive = useUIStore((state) => state.activeMainTab === 'assistant');
  const active = activeOverride ?? mainTabActive;
  const mobileFromStore = useUIStore((state) => state.isMobile);
  // Dedicated mobile tabs can be rendered in a desktop-width browser during
  // preview. The app-owned mobile state is authoritative for their layout.
  const isMobileSurface = isMobile || mobileFromStore;
  const capabilityQuery = useAssistantCapabilityQuery();
  const snapshotQuery = useAssistantSnapshotQuery();
  const snapshot = snapshotQuery.data;
  const contacts = React.useMemo(() => partitionAssistantContacts(snapshot?.assistants ?? []), [snapshot?.assistants]);
  const selectedAssistantID = useAssistantUIStore((state) => state.assistantByTransport[transport] ?? null);
  const selectAssistant = useAssistantUIStore((state) => state.selectAssistant);
  const requestCreate = useAssistantUIStore((state) => state.requestCreate);
  const assistant = snapshot?.assistants.find((item) => item.id === selectedAssistantID) ?? null;

  React.useEffect(() => { if (!selectedAssistantID && snapshot?.assistants[0]) selectAssistant(snapshot.assistants[0].id); }, [selectAssistant, selectedAssistantID, snapshot?.assistants]);
  React.useEffect(() => { if (snapshotQuery.isSuccess && selectedAssistantID && !assistant) selectAssistant(snapshot?.assistants[0]?.id ?? null); }, [assistant, selectAssistant, selectedAssistantID, snapshot?.assistants, snapshotQuery.isSuccess]);

  const openCreateSettings = useEvent(() => { requestCreate(); if (mobileActions) { mobileActions.openSettings(); return; } const ui = useUIStore.getState(); ui.setSettingsPage('assistants'); ui.setSettingsDialogOpen(true); });
  const openEditSettings = useEvent((assistantID: string) => {
    openAssistantSettings(assistantID, mobileActions ? { openMobileSettings: mobileActions.openSettings } : undefined);
  });
  const openConversationSettings = useEvent(() => {
    if (!assistant) return;
    openAssistantSettings(assistant.id, mobileActions ? { openMobileSettings: mobileActions.openSettings } : undefined);
  });
  const [deleteTarget, setDeleteTarget] = React.useState<AssistantDTO | null>(null);
  const requestDeleteAssistant = useEvent((item: AssistantDTO) => {
    setDeleteTarget(item);
  });
  const handleDeleteDialogOpenChange = useEvent((open: boolean) => {
    if (!open) setDeleteTarget(null);
  });
  const returnToChat = useEvent(() => { useUIStore.getState().setActiveMainTab('chat'); });
  const handleMobileBack = useEvent(() => {
    if (onMobileBack) {
      onMobileBack();
      return;
    }
    returnToChat();
  });
  const workspaceState = resolveAssistantWorkspacePresentation({
    capabilityPending: capabilityQuery.isPending,
    snapshotPending: snapshotQuery.isPending,
    capabilityError: capabilityQuery.isError,
    supported: capabilityQuery.data?.supported,
    capabilityEnabled: capabilityQuery.data?.enabled,
    snapshotEnabled: snapshot?.enabled,
    snapshotSettled: snapshotQuery.isSuccess,
    assistantCount: snapshot?.assistants.length ?? 0,
    hasAssistant: Boolean(assistant),
  });
  const renderState = (icon: 'cloud-off' | 'error-warning' | 'ai-agent', title: string, description?: string, action?: React.ReactNode) => <div className="yuri-assistant-wallpaper yuri-assistant-workspace relative flex h-full min-h-0 flex-col overflow-clip" data-assistant-layout={isMobileSurface ? 'mobile' : 'desktop'}>{isMobileSurface ? <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} onOpenSettings={onMobileOpenSettings} /> : null}<div className="yuri-assistant-state flex min-h-0 flex-1 flex-col items-center justify-center px-6 pt-[calc(max(0.25rem,var(--yuri-safe-area-top,0px))+var(--yuri-mobile-detail-navigation-height,3.5rem))] text-center"><Icon name={icon} className="size-6 text-muted-foreground" /><h1 className="mt-4 typography-ui-header font-semibold">{title}</h1>{description ? <p className="mt-2 max-w-md typography-ui text-muted-foreground">{description}</p> : null}{action ? <div className="mt-5">{action}</div> : null}</div></div>;
  if (workspaceState === 'loading') {
    return (
      <div className="yuri-assistant-wallpaper yuri-assistant-workspace relative flex h-full min-h-0 flex-col overflow-clip" data-assistant-layout={isMobileSurface ? 'mobile' : 'desktop'}>
        {isMobileSurface ? <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} onOpenSettings={onMobileOpenSettings} /> : null}
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pt-[calc(max(0.25rem,var(--yuri-safe-area-top,0px))+var(--yuri-mobile-detail-navigation-height,3.5rem))] text-center"
          aria-busy="true"
          aria-label={t('common.loading')}
          data-assistant-workspace-loading=""
        >
          <Icon name="loader-4" className="size-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  if (workspaceState === 'unavailable') return renderState('cloud-off', t('assistants.state.unavailable'));
  if (workspaceState === 'onboarding') return renderState('ai-agent', t('assistants.onboarding.title'), t('assistants.onboarding.description'), <Button onClick={openCreateSettings}>{t('assistants.onboarding.action')}</Button>);
  if (!snapshot || !assistant) return renderState('cloud-off', t('assistants.state.unavailable'));
  const warning = snapshotQuery.isError ? t('assistants.state.staleSnapshot') : null;
  return (
    <div className="relative flex h-full min-h-0 overflow-clip yuri-assistant-wallpaper yuri-assistant-workspace" data-presentation="workspace" data-assistant-layout={isMobileSurface ? 'mobile' : 'desktop'}>
      {isMobileSurface ? null : (
        <section className="flex h-full min-h-0 w-[clamp(15rem,20vw,17.5rem)] shrink-0 flex-col overflow-clip yuri-assistant-catalog-panel">
          <header className="flex shrink-0 items-center gap-3 px-4 py-4 sm:px-5">
            <h1 className="min-w-0 truncate typography-ui-label font-semibold text-foreground">{t('assistants.title')}</h1>
            <AssistantMarkAllReadButton snapshot={snapshot} compact rowClassName="flex min-w-0 flex-1 justify-end" />
            <Button
              type="button"
              variant="mobileGlass"
              size="mobileIcon"
              className="size-8 min-h-0 min-w-0"
              aria-label={t('assistants.settings.create')}
              onClick={openCreateSettings}
            >
              <Icon name="add" className="size-4" />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label={t('assistants.listAria')}>
            <AssistantPinnedContacts contacts={contacts.pinned} selectedAssistantID={selectedAssistantID} onSelect={selectAssistant} onEdit={openEditSettings} onDelete={requestDeleteAssistant} />
            <div className="flex flex-col gap-1 pt-1">
              {contacts.unpinned.map((item) => {
                const selected = item.id === selectedAssistantID;
                const itemPresentation = getAssistantPresentation(item.name);
                return (
                  <AssistantListItem
                    key={item.id}
                    assistant={item}
                    assistantID={item.id}
                    avatarSeed={item.avatarSeed}
                    unreadCount={item.unreadCount ?? 0}
                    summary={getAssistantMessagePreview(item.latestMessagePreview, t)}
                    displayName={itemPresentation.displayName}
                    selected={selected}
                    assignedSessionIDs={item.assignedSessionIDs}
                    serverWorking={item.working}
                    onSelect={() => selectAssistant(item.id)}
                    onEdit={() => openEditSettings(item.id)}
                    onDelete={() => requestDeleteAssistant(item)}
                  />
                );
              })}
            </div>
          </div>
        </section>
      )}
      <AssistantDeleteConfirmDialog
        assistant={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={handleDeleteDialogOpenChange}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip yuri-assistant-pane">
        {isMobileSurface ? (
          <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} onOpenSettings={onMobileOpenSettings} />
        ) : (
          <header className="yuri-assistant-conversation-header">
            <AssistantHeaderIdentity assistant={assistant} onClick={openConversationSettings} />
          </header>
        )}
        <AssistantConversationSurface
          assistant={assistant}
          warning={warning}
          active={active}
          overlayHeader={isMobileSurface}
          overlayComposer
        />
      </div>
    </div>
  );
};
