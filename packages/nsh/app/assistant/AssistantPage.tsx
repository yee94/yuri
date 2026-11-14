import { Scroll, Text, View, signal } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { PrimaryButton, QuietButton, Surface, actionMenu, alpha, confirm } from '../core/ui';
import { showToast } from '../core/toast';
import { openAssistant, openAssistantSettings, openSettingsPage, tabBarInset } from '../shell/nav';
import { AssistantCard } from './AssistantCard';
import { AssistantGuide, AssistantSkeleton } from './AssistantGuide';
import { AssistantUnread, AssistantWorkingAvatar } from './Avatar';
import {
  assistantCapability,
  assistantContacts,
  assistantError,
  assistantLoading,
  assistantSnapshot,
  assistantTitle,
  assistants,
  deleteAssistant,
  loadAssistants,
  markAllAssistantsRead,
  toggleAssistantPin,
  type Assistant,
} from './data';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Web `yuri-mobile-assistant-state-card`: icon, title and one line of help. */
function StateCard(props: { icon: 'cloud-off' | 'sparkling'; title: string; description?: string }) {
  return (
    <Surface style={{ width: '100%', padding: 20, gap: 8 }}>
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: alpha(colors.foreground(), 0.08),
        }}
      >
        <Icon name={props.icon} size={20} tone="muted" />
      </View>
      <Text style={{ marginTop: 12, maxWidth: 300, fontSize: 18, fontWeight: '600', lineHeight: 23, color: colors.foreground() }}>
        {props.title}
      </Text>
      <If when={!!props.description}>
        <Text style={{ marginTop: 4, fontSize: 13, lineHeight: 19, color: colors.mutedForeground() }}>
          {props.description ?? ''}
        </Text>
      </If>
    </Surface>
  );
}

/** The bots tab: pinned contact, every bot's latest message, unread badges and swipe actions. */
export function AssistantPage() {
  const busy = signal(false);

  if (!assistantCapability() && !assistantLoading()) void loadAssistants();

  const reload = () => {
    void loadAssistants(true);
  };

  const open = (assistant: Assistant) => {
    openAssistant({ assistantID: assistant.id, title: assistantTitle(assistant) });
  };

  const edit = (assistant: Assistant) => {
    openAssistantSettings(assistant.id);
  };

  const remove = async (assistant: Assistant) => {
    const confirmed = await confirm({
      title: t('assistants.settings.delete'),
      message: t('assistants.settings.deleteConfirm', { name: assistantTitle(assistant) }),
      confirmLabel: t('assistants.settings.delete'),
      cancelLabel: t('gitView.common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await deleteAssistant(assistant.id, assistant.revision);
      showToast({ message: t('assistants.settings.toast.deleted') });
    } catch {
      showToast({ message: t('assistants.settings.toast.deleteFailed') });
    }
  };

  const pin = async (assistant: Assistant) => {
    try {
      await toggleAssistantPin(assistant);
    } catch {
      showToast({ message: t('assistants.menu.pinError') });
    }
  };

  const openMenu = async (assistant: Assistant) => {
    const action = await actionMenu({
      title: assistantTitle(assistant),
      actions: [
        {
          id: 'pin',
          label: t(assistant.pinnedAt == null ? 'assistants.menu.pin' : 'assistants.menu.unpin'),
        },
        { id: 'edit', label: t('assistants.menu.edit') },
        { id: 'delete', label: t('assistants.settings.delete'), destructive: true },
      ],
    });
    if (action === 'pin') void pin(assistant);
    if (action === 'edit') edit(assistant);
    if (action === 'delete') void remove(assistant);
  };

  const markAll = async () => {
    if (busy()) return;
    busy.set(true);
    try {
      const failed = await markAllAssistantsRead();
      if (failed > 0) showToast({ message: t('assistants.unread.markAllFailed') });
    } catch {
      showToast({ message: t('assistants.unread.markAllFailed') });
    } finally {
      busy.set(false);
    }
  };

  const canList = () =>
    assistantCapability()?.supported === true &&
    assistantCapability()?.enabled !== false &&
    !!assistantSnapshot() &&
    assistantSnapshot()?.enabled === true;
  const isEmpty = () => canList() && assistants().length === 0;
  const unavailable = () => !!assistantError();
  const unsupported = () => assistantCapability()?.supported === false;
  const disabled = () =>
    !unavailable() &&
    assistantCapability()?.supported === true &&
    (assistantCapability()?.enabled === false || assistantSnapshot()?.enabled === false);

  const headerRight = (
    <If when={canList() && assistants().length > 0}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <If when={assistants().some((assistant) => assistant.unreadCount > 0)}>
        <Button
          testID="assistants-mark-all"
          onPress={() => void markAll()}
          accessibilityLabel={t('assistants.unread.markAll')}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: alpha(colors.card(), 0.88),
            backdropFilter: 'blur(20px) saturate(1.25)',
          }}
        >
          <Icon name="check-double" size={20} />
        </Button>
      </If>
      <Button
        testID="assistants-create"
        onPress={() => openAssistantSettings('new')}
        accessibilityLabel={t('assistants.settings.create')}
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.foreground(),
        }}
      >
        <Icon name="add" size={20} color={() => colors.background()} />
      </Button>
    </View>
    </If>
  );

  return (
    <NavPage
      title={t('assistants.title')}
      headerLargeTitle
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerRight={headerRight}
    >
      <Scroll class="flex-1" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: 14,
          }}
        >
          <If when={!assistantSnapshot() && !unavailable() && !unsupported()}>
            <AssistantSkeleton />
          </If>

          <If when={unavailable() || unsupported()}>
            <StateCard
              icon="cloud-off"
              title={unavailable() ? t('assistants.state.unavailable') : t('assistants.state.unsupportedTitle')}
              description={unavailable() ? undefined : t('assistants.state.unsupportedDescription')}
            />
            <If when={unavailable()}>
              <QuietButton label={() => t('assistants.actions.retry')} onPress={reload} />
            </If>
          </If>

          <If when={disabled()}>
            <AssistantGuide onEnable={() => openSettingsPage('assistants')} />
          </If>

          <If when={isEmpty()}>
            <Surface style={{ width: '100%', padding: 24, gap: 2 }}>
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: alpha(colors.foreground(), 0.08),
                }}
              >
                <Icon name="ai-agent" size={20} />
              </View>
              <Text style={{ marginTop: 20, fontSize: 18, fontWeight: '600', lineHeight: 23, letterSpacing: -0.45, color: colors.foreground() }}>
                {t('assistants.onboarding.title')}
              </Text>
              <Text style={{ marginTop: 8, fontSize: 13, lineHeight: 20, color: colors.mutedForeground() }}>
                {t('assistants.onboarding.description')}
              </Text>
              <View style={{ marginTop: 24 }}>
                <PrimaryButton
                  label={() => t('assistants.onboarding.action')}
                  icon="add"
                  onPress={() => openAssistantSettings('new')}
                />
              </View>
            </Surface>
          </If>

          <If when={canList() && assistants().length > 0}>
            <View style={{ gap: 14 }}>
              <If when={assistantContacts().pinned.length > 0}>
                <View
                  role="group"
                  accessibilityLabel={t('assistants.list.pinned')}
                  style={{ alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 12 }}
                >
                  <Each of={assistantContacts().pinned} key={(assistant) => `pinned-${assistant.id}`}>
                    {(entry) => (
                      <View
                        testID={`assistant-pinned-${entry().id}`}
                        role="button"
                        onPress={() => open(entry())}
                        onLongPress={() => void openMenu(entry())}
                        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
                        style={{
                          width: '100%',
                          maxWidth: 112,
                          alignItems: 'center',
                          gap: 8,
                          borderRadius: 16,
                          paddingHorizontal: 8,
                          paddingVertical: 12,
                        }}
                      >
                        <View style={{ position: 'relative' }}>
                          <AssistantWorkingAvatar
                            seed={entry().avatarSeed ?? entry().id}
                            size={64}
                            label={assistantTitle(entry())}
                            working={entry().working}
                          />
                          <View style={{ position: 'absolute', right: -4, top: -4 }}>
                            <AssistantUnread count={entry().unreadCount} />
                          </View>
                        </View>
                        <Text
                          style={{
                            width: '100%',
                            fontSize: 13,
                            fontWeight: '500',
                            lineHeight: 20,
                            color: colors.foreground(),
                            textAlign: 'center',
                            numberOfLines: 1,
                          }}
                        >
                          {assistantTitle(entry())}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>

              <Each of={assistantContacts().unpinned} key={(assistant) => assistant.id}>
                {(entry) => (
                  <AssistantCard
                    assistant={entry}
                    onOpen={() => open(entry())}
                    onEdit={() => edit(entry())}
                    onDelete={() => void remove(entry())}
                    onMenu={() => void openMenu(entry())}
                  />
                )}
              </Each>
            </View>
          </If>
        </View>
      </Scroll>
    </NavPage>
  );
}
