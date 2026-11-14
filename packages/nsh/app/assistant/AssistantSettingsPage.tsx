import { Image, Scroll, Text, View, signal, type ImageAsset } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { ChoiceSheet, PrimaryButton, QuietButton, alpha, confirm, type Choice } from '../core/ui';
import { showToast } from '../core/toast';
import { defaultModel, loadCatalog, providers } from '../core/models';
import { projects } from '../core/store';
import { activeStack, openScheduledTask } from '../shell/nav';
import { formatScheduleOf } from '../scheduled/data';
import { AssistantAvatar } from './Avatar';
import { AssistantChannelSheet, type ChannelID } from './AssistantChannelSheet';
import wechatLogo from './assets/channels/wechat.svg';
import wecomLogo from './assets/channels/wecom.svg';
import feishuLogo from './assets/channels/feishu.svg';
import dingtalkLogo from './assets/channels/dingtalk.svg';
import {
  assistantByID,
  assistantTitle,
  assistants,
  deleteAssistant,
  loadAssistants,
  readAssistantTasks,
  readChannel,
  readWeixin,
  saveAssistant,
  type Assistant,
  type AssistantTask,
} from './data';
import { Empty, Group, Loading, Row } from '../settings/ui';

type Picker = 'model' | 'workspace' | null;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const assistantChannels: { id: ChannelID; title: () => string; summary: () => string; logo: ImageAsset }[] = [
  { id: 'wechat', title: () => t('assistants.weixin.title'), summary: () => t('assistants.channels.wechat.summary'), logo: wechatLogo },
  { id: 'wecom', title: () => t('assistants.channels.wecom.title'), summary: () => t('assistants.channels.wecom.summary'), logo: wecomLogo },
  { id: 'feishu', title: () => t('assistants.channels.feishu.title'), summary: () => t('assistants.channels.feishu.summary'), logo: feishuLogo },
  { id: 'dingtalk', title: () => t('assistants.channels.dingtalk.title'), summary: () => t('assistants.channels.dingtalk.summary'), logo: dingtalkLogo },
];

const channelStatusLabel = (status: string): string => {
  switch (status) {
    case 'connected':
      return t('assistants.channels.status.connected');
    case 'connecting':
      return t('assistants.channels.status.connecting');
    case 'reconnecting':
      return t('assistants.channels.status.reconnecting');
    case 'error':
      return t('assistants.channels.status.error');
    case 'scanned':
      return t('assistants.weixin.status.scanned');
    case 'verify':
      return t('assistants.weixin.status.verify');
    case 'waiting':
      return t('assistants.weixin.status.waiting');
    case 'expired':
      return t('assistants.weixin.status.expired');
    case 'disabled':
      return t('assistants.channels.status.disabled');
    case 'unsupported':
      return t('assistants.channels.status.unsupported');
    case 'disconnected':
      return t('assistants.channels.status.disconnected');
    default:
      return '';
  }
};

const taskStatusIcon = (status: string, enabled: boolean) => {
  if (!enabled) return 'pause' as const;
  if (status === 'running') return 'loader-4' as const;
  if (status === 'success') return 'checkbox-circle' as const;
  if (status === 'error') return 'error-warning' as const;
  return 'pulse' as const;
};

const taskStatusLabel = (status: string, enabled: boolean): string => {
  if (!enabled) return t('sessions.scheduledTasks.dialog.taskToggle.paused');
  if (status === 'running') return t('sessions.scheduledTasks.dialog.status.running');
  if (status === 'success') return t('sessions.scheduledTasks.dialog.status.success');
  if (status === 'error') return t('sessions.scheduledTasks.dialog.status.error');
  return t('sessions.scheduledTasks.dialog.status.idle');
};

const taskStatusColor = (status: string, enabled: boolean): string => {
  if (!enabled) return colors.mutedForeground();
  if (status === 'running') return statusColor('warning');
  if (status === 'success') return statusColor('success');
  if (status === 'error') return statusColor('error');
  return colors.mutedForeground();
};

const assistantWorkspaceOptions = (): Choice<string>[] =>
  projects().map((project) => ({ value: project.path, label: project.label, description: project.path }));

/** One bot: identity, model, workspace, channels, its scheduled tasks and delete. */
export function AssistantSettingsPage(props: { assistantID: string }) {
  const creating = props.assistantID === 'new';
  const selected = creating ? null : assistantByID(props.assistantID);
  if (!selected && !creating && assistants().length === 0) void loadAssistants();
  if (providers().length === 0) void loadCatalog();

  const seed = selected?.avatarSeed ?? selected?.id ?? 'new';
  const name = signal(selected?.name ?? '');
  const prompt = signal(selected?.defaultPrompt ?? '');
  const avatarSeed = signal(seed);
  const fallbackModel = defaultModel();
  const providerID = signal(selected?.providerID ?? fallbackModel?.providerID ?? providers()[0]?.id ?? '');
  const modelID = signal(
    selected?.modelID ?? fallbackModel?.modelID ?? providers()[0]?.models[0]?.id ?? '',
  );
  const workspacePath = signal(selected?.workspacePath ?? '');
  const busy = signal(false);
  const picker = signal<Picker>(null);
  const channel = signal<ChannelID | null>(null);
  const tasks = signal<AssistantTask[] | null>(null);
  const tasksFailed = signal(false);
  const channelLabels = signal<Record<string, string>>({});

  const loadChannels = async () => {
    if (creating) return;
    const next: Record<string, string> = {};
    const wechat = await readWeixin(props.assistantID);
    next.wechat = wechat.status;
    for (const provider of ['wecom', 'feishu', 'dingtalk'] as const) {
      const value = await readChannel(props.assistantID, provider);
      next[provider] = value.status;
    }
    channelLabels.set(next);
  };
  const loadTasks = async () => {
    if (creating) return;
    try {
      tasks.set(await readAssistantTasks(props.assistantID));
      tasksFailed.set(false);
    } catch {
      tasks.set([]);
      tasksFailed.set(true);
    }
  };
  if (!creating && !tasks()) {
    void loadChannels();
    void loadTasks();
  }

  const reload = () => {
    void loadAssistants(true);
    void loadTasks();
    void loadChannels();
  };

  const modelLabel = () => {
    const provider = providers().find((entry) => entry.id === providerID());
    const model = provider?.models.find((entry) => entry.id === modelID());
    if (!provider) return t('assistants.state.invalidConfiguration');
    return `${provider.name} · ${model?.name ?? modelID()}`;
  };

  const modelChoices = (): Choice<string>[] =>
    providers().flatMap((provider) =>
      provider.models.map((model) => ({
        value: `${provider.id}/${model.id}`,
        label: model.name,
        description: provider.name,
      })),
    );

  const workspaceChoices = (): Choice<string>[] => [
    { value: '', label: t('assistants.settings.workspacePlaceholder') },
    ...assistantWorkspaceOptions(),
  ];

  const save = async () => {
    if (busy()) return;
    if (!name().trim() || !providerID() || !modelID()) {
      showToast({ message: t('assistants.settings.validation.required') });
      return;
    }
    busy.set(true);
    try {
      await saveAssistant(selected, {
        name: name().trim(),
        avatarSeed: avatarSeed(),
        defaultPrompt: prompt(),
        workspacePath: workspacePath() || null,
        providerID: providerID(),
        modelID: modelID(),
      });
      showToast({ message: t('assistants.settings.toast.saved') });
      activeStack().pop();
    } catch {
      showToast({ message: t('assistants.settings.toast.saveFailed') });
    } finally {
      busy.set(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const confirmed = await confirm({
      title: t('assistants.settings.delete'),
      message: t('assistants.settings.deleteConfirm', { name: assistantTitle(selected) }),
      confirmLabel: t('assistants.settings.delete'),
      cancelLabel: t('gitView.common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await deleteAssistant(selected.id, selected.revision);
      showToast({ message: t('assistants.settings.toast.deleted') });
      activeStack().pop();
    } catch {
      showToast({ message: t('assistants.settings.toast.deleteFailed') });
    }
  };

  const title = creating ? t('assistants.settings.create') : selected ? assistantTitle(selected) : t('assistants.title');

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <If when={!!selected}>
        <Button
          testID="assistant-save"
          onPress={() => void save()}
          disabled={busy()}
          accessibilityLabel={t('assistants.settings.save')}
          style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="check" size={20} />
        </Button>
        <Button
          testID="assistant-delete"
          onPress={() => void remove()}
          disabled={busy()}
          accessibilityLabel={t('assistants.settings.delete')}
          style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="delete-bin" size={18} color={() => colors.destructive()} />
        </Button>
      </If>
      <If when={creating}>
        <Button
          testID="assistant-save"
          onPress={() => void save()}
          disabled={busy()}
          accessibilityLabel={t('assistants.settings.save')}
          style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={busy() ? 'loader-4' : 'check'} size={20} />
        </Button>
      </If>
    </View>
  );

  const loading = () => !creating && !selected && assistants().length === 0;

  return (
    <NavPage
      title={title}
      headerBackTitle={t('assistants.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerRight={headerRight}
    >
      <Scroll class="flex-1" keyboardDismissMode="on-drag" contentStyle={{ paddingBottom: 40 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: 20,
            paddingTop: 8,
          }}
        >
          <If when={loading()}>
            <Loading />
          </If>

          <If when={!creating && !selected && !loading()}>
            <Group label={t('assistants.title')}>
              <View style={{ padding: 20, gap: 12, alignItems: 'center' }}>
                <Icon name="cloud-off" size={24} tone="muted" />
                <Text style={{ fontSize: 14, color: colors.mutedForeground(), textAlign: 'center' }}>
                  {t('assistants.state.unavailable')}
                </Text>
                <QuietButton label={() => t('assistants.actions.retry')} onPress={reload} />
              </View>
            </Group>
          </If>

          <If when={creating || !!selected}>
            <View style={{ borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: colors.border() }}>
              <View style={{ padding: 16, alignItems: 'center', gap: 10 }}>
                <View testID="assistant-avatar" role="button" onPress={() => avatarSeed.set(Math.random().toString(36).slice(2, 10))}>
                  <AssistantAvatar seed={avatarSeed()} size={72} label={name() || title} />
                </View>
                <Button
                  onPress={() => avatarSeed.set(Math.random().toString(36).slice(2, 10))}
                  accessibilityLabel={t('assistants.settings.randomAvatar')}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4 }}
                >
                  <Icon name="refresh" size={14} tone="muted" />
                  <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>
                    {t('assistants.settings.randomAvatar')}
                  </Text>
                </Button>
              </View>
            </View>
          </If>

          <Group>
            <View style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
              <Input
                testID="assistant-name"
                value={name()}
                onChange={(event) => name.set(event.value)}
                placeholder={t('assistants.settings.name')}
                style={{
                  minHeight: 40,
                  fontSize: 16,
                  color: colors.foreground(),
                  placeholderColor: colors.mutedForeground(),
                }}
              />
            </View>
            <Row
              testID="assistant-model"
              label={t('assistants.settings.model')}
              value={modelLabel}
              onPress={() => picker.set('model')}
            />
            <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 6 }}>
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.mutedForeground() }}>
                {t('assistants.settings.defaultPrompt')}
              </Text>
              <Input
                testID="assistant-prompt"
                value={prompt()}
                onChange={(event) => prompt.set(event.value)}
                placeholder={t('assistants.settings.defaultPromptPlaceholder')}
                multiline
                style={{
                  minHeight: 200,
                  fontSize: 15,
                  lineHeight: 21,
                  color: colors.foreground(),
                  placeholderColor: colors.mutedForeground(),
                }}
              />
            </View>
          </Group>

          <Group label={t('assistants.settings.workspace')}>
            <Row
              testID="assistant-workspace"
              value={() => workspacePath() || t('assistants.settings.workspacePlaceholder')}
              description={t('assistants.settings.workspaceChangeHint')}
              onPress={() => picker.set('workspace')}
            />
          </Group>

          <If when={!creating}>
            <Group label={t('assistants.settings.scheduledTasks.title')}>
              <If when={!tasks()}>
                <Loading />
              </If>
              <If when={!!tasks() && (tasks() ?? []).length === 0}>
                <Empty text={t('assistants.settings.scheduledTasks.empty')} />
              </If>
              <Each of={tasks() ?? []} key={(task) => `${task.projectID}:${task.taskID}`}>
                {(task) => (
                  <Row
                    label={task().name}
                    description={() => formatScheduleOf(task().schedule)}
                    onPress={() =>
                      openScheduledTask({ projectId: task().projectID, taskId: task().taskID })
                    }
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Icon
                        name={taskStatusIcon(task().lastStatus, task().enabled)}
                        size={14}
                        color={() => taskStatusColor(task().lastStatus, task().enabled)}
                      />
                      <Text style={{ fontSize: 12, color: taskStatusColor(task().lastStatus, task().enabled) }}>
                        {taskStatusLabel(task().lastStatus, task().enabled)}
                      </Text>
                    </View>
                  </Row>
                )}
              </Each>
              <If when={tasksFailed()}>
                <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
                  <QuietButton label={() => t('assistants.actions.retry')} onPress={() => void loadTasks()} />
                </View>
              </If>
            </Group>
          </If>

          <If when={!creating}>
            <Group label={t('assistants.channels.title')}>
              <View style={{ paddingHorizontal: 6, paddingTop: 6 }}>
                <Text style={{ paddingHorizontal: 8, fontSize: 12, lineHeight: 17, color: colors.mutedForeground() }}>
                  {t('assistants.channels.description')}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 8 }}>
                <Each of={assistantChannels} key={(entry) => entry.id}>
                  {(entry) => (
                    <View
                      testID={`assistant-channel-${entry().id}`}
                      role="button"
                      onPress={() => channel.set(entry().id)}
                      activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
                      style={{
                        width: '48%',
                        minHeight: 80,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: alpha(colors.border(), 0.9),
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                      }}
                    >
                      <Image src={entry().logo} style={{ width: 32, height: 32 }} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 13, color: colors.foreground(), numberOfLines: 1 }}>
                          {entry().title()}
                        </Text>
                        <Text
                          style={{
                            marginTop: 2,
                            fontSize: 12,
                            lineHeight: 16,
                            color: colors.mutedForeground(),
                            numberOfLines: 1,
                          }}
                        >
                          {channelStatusLabel(channelLabels()[entry().id] ?? '') || entry().summary()}
                        </Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </Group>
          </If>

          <If when={creating || !!selected}>
            <PrimaryButton
              label={() => t('assistants.settings.save')}
              busy={busy}
              onPress={() => void save()}
            />
          </If>
        </View>
      </Scroll>

      <ChoiceSheet
        open={() => picker() === 'model'}
        title={t('assistants.settings.model')}
        options={modelChoices}
        value={() => `${providerID()}/${modelID()}`}
        onSelect={(value) => {
          const separator = value.indexOf('/');
          providerID.set(value.slice(0, separator));
          modelID.set(value.slice(separator + 1));
        }}
        onClose={() => picker.set(null)}
      />
      <ChoiceSheet
        open={() => picker() === 'workspace'}
        title={t('assistants.settings.workspace')}
        options={workspaceChoices}
        value={() => workspacePath()}
        onSelect={(value) => workspacePath.set(value)}
        onClose={() => picker.set(null)}
      />
      <If when={channel() !== null}>
        <AssistantChannelSheet
          open={() => channel() !== null}
          assistantID={props.assistantID}
          channel={() => channel() ?? 'wechat'}
          onClose={() => {
            channel.set(null);
            void loadChannels();
          }}
        />
      </If>
    </NavPage>
  );
}
