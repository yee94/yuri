import { Scroll, Text, View, signal } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { PrimaryButton, QuietButton, Spinner, Surface, actionMenu, alpha, confirm, fontSize } from '../core/ui';
import { openAssistant, openAssistantSettings, openSettingsPage, tabBarInset } from '../shell/nav';
import { AssistantCard } from './AssistantCard';
import { AssistantAvatar, AssistantUnread } from './Avatar';
import {
  assistantCapability,
  assistantContacts,
  assistantError,
  assistantLoading,
  assistantSnapshot,
  assistantTitle,
  assistants,
  assistantsEnabled,
  deleteAssistant,
  loadAssistants,
  markAllAssistantsRead,
  type Assistant,
} from './data';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function StateCard(props: { icon: 'ai-agent' | 'sparkling' | 'cloud'; title: string; description?: string }) {
  return (
    <Surface style={{ padding: 20, gap: 8 }}>
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
      <Text style={{ marginTop: 8, fontSize: 18, fontWeight: '600', color: colors.foreground() }}>{props.title}</Text>
      <If when={!!props.description}>
        <Text style={{ fontSize: fontSize.entityTitle, lineHeight: 20, color: colors.mutedForeground() }}>
          {props.description ?? ''}
        </Text>
      </If>
    </Surface>
  );
}

/** The bots tab: pinned contact, every bot's latest message, unread badges and swipe actions. */
export function AssistantPage() {
  const busy = signal(false);
  const failure = signal('');

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
    } catch (error) {
      failure.set(errorText(error));
    }
  };

  const openMenu = async (assistant: Assistant) => {
    const action = await actionMenu({
      title: assistantTitle(assistant),
      actions: [
        { id: 'edit', label: t('assistants.menu.edit') },
        { id: 'delete', label: t('assistants.settings.delete'), destructive: true },
      ],
    });
    if (action === 'edit') edit(assistant);
    if (action === 'delete') void remove(assistant);
  };

  const markAll = async () => {
    if (busy()) return;
    busy.set(true);
    failure.set('');
    try {
      const failed = await markAllAssistantsRead();
      if (failed > 0) failure.set(t('assistants.unread.markAllFailed'));
    } catch (error) {
      failure.set(errorText(error));
    } finally {
      busy.set(false);
    }
  };

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <If when={assistants().some((assistant) => assistant.unreadCount > 0)}>
        <Button
          onPress={() => void markAll()}
          accessibilityLabel={t('assistants.unread.markAll')}
          style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="check-double" size={20} />
        </Button>
      </If>
      <Button
        testID="assistants-create"
        onPress={() => openAssistantSettings('new')}
        accessibilityLabel={t('assistants.settings.create')}
        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="add" size={22} />
      </Button>
    </View>
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
          <If when={!!(failure() || assistantError())}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.destructive() }}>{failure() || assistantError()}</Text>
              <QuietButton label={() => t('assistants.actions.retry')} onPress={reload} />
            </Surface>
          </If>

          <If when={!assistantCapability() || (assistantLoading() && !assistantSnapshot())}>
            <Surface style={{ padding: 24, alignItems: 'center' }}>
              <Icon name="ai-agent" size={24} tone="muted" />
            </Surface>
          </If>

          <If when={assistantCapability()?.supported === false}>
            <StateCard
              icon="cloud"
              title={t('assistants.state.unsupportedTitle')}
              description={t('assistants.state.unsupportedDescription')}
            />
          </If>

          <If
            when={
              assistantCapability()?.supported === true &&
              (assistantCapability()?.enabled === false || !assistantsEnabled()) &&
              !!assistantSnapshot()
            }
          >
            <View style={{ gap: 12 }}>
              <StateCard
                icon="sparkling"
                title={t('assistants.guide.disabledTitle')}
                description={t('assistants.guide.disabledDescription')}
              />
              <PrimaryButton
                label={() => t('assistants.guide.enableAction')}
                onPress={() => openSettingsPage('assistants')}
              />
            </View>
          </If>

          <If
            when={
              assistantCapability()?.supported === true &&
              assistantCapability()?.enabled !== false &&
              assistantsEnabled() &&
              assistants().length === 0
            }
          >
            <Surface style={{ padding: 24, gap: 8 }}>
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
                <Icon name="ai-agent" size={18} tone="muted" />
              </View>
              <Text style={{ marginTop: 8, fontSize: 18, fontWeight: '600', color: colors.foreground() }}>
                {t('assistants.onboarding.title')}
              </Text>
              <Text style={{ fontSize: fontSize.entityTitle, lineHeight: 21, color: colors.mutedForeground() }}>
                {t('assistants.onboarding.description')}
              </Text>
              <View style={{ marginTop: 12 }}>
                <PrimaryButton
                  label={() => t('assistants.onboarding.action')}
                  icon="add"
                  onPress={() => openSettingsPage('assistants')}
                />
              </View>
            </Surface>
          </If>

          <Each of={assistantContacts().pinned} key={(assistant) => `pinned-${assistant.id}`}>
            {(entry) => (
              <View
                testID={`assistant-pinned-${entry().id}`}
                role="button"
                onPress={() => open(entry())}
                onLongPress={() => void openMenu(entry())}
                style={{ alignSelf: 'center', alignItems: 'center', gap: 8, maxWidth: 140, paddingVertical: 4 }}
              >
                <View style={{ width: 64, height: 64 }}>
                  <AssistantAvatar seed={entry().avatarSeed ?? entry().id} size={64} label={assistantTitle(entry())} />
                  <If when={entry().working}>
                    <View style={{ position: 'absolute', right: -4, bottom: -4, backgroundColor: colors.background(), borderRadius: 7, padding: 1 }}>
                      <Spinner size={12} />
                    </View>
                  </If>
                  <View style={{ position: 'absolute', right: -4, top: -4 }}>
                    <AssistantUnread count={entry().unreadCount} />
                  </View>
                </View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
                  {assistantTitle(entry())}
                </Text>
              </View>
            )}
          </Each>

          <View style={{ gap: 14 }}>
            <Each of={assistantContacts().unpinned} key={(assistant) => assistant.id}>
              {(entry) => (
                <AssistantCard
                  assistant={entry}
                  onOpen={() => open(entry())}
                  onEdit={() => edit(entry())}
                  onDelete={() => void remove(entry())}
                />
              )}
            </Each>
          </View>

          <If
            when={
              assistantCapability()?.supported === true &&
              assistantCapability()?.enabled !== false &&
              assistantsEnabled() &&
              assistants().length === 0
            }
          >
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), textAlign: 'center' }}>
              {t('assistants.subtitle')}
            </Text>
          </If>
        </View>
      </Scroll>
    </NavPage>
  );
}
