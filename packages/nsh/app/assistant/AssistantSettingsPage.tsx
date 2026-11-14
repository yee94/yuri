import { Scroll, Text, View, signal } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { ChoiceSheet, PrimaryButton, alpha, confirm, fontSize, type Choice } from '../core/ui';
import { agents, defaultModel, loadCatalog, providers } from '../core/models';
import { projects } from '../core/store';
import { openScheduledRuns, activeStack } from '../shell/nav';
import { AssistantAvatar } from './Avatar';
import { AssistantChannelSheet, type ChannelID } from './AssistantChannelSheet';
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

type Picker = 'model' | 'agent' | 'mode' | 'workspace' | null;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const assistantsWorkspaceOptions = (): Choice<string>[] =>
  projects().map((project) => ({ value: project.path, label: project.label, description: project.path }));

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

const taskStatusLabel = (status: string): string => {
  if (status === 'running') return t('sessions.scheduledTasks.dialog.status.running');
  if (status === 'success') return t('sessions.scheduledTasks.dialog.status.success');
  if (status === 'error') return t('sessions.scheduledTasks.dialog.status.error');
  return t('sessions.scheduledTasks.dialog.status.idle');
};

function Row(props: { label: string; value?: string | (() => string); onPress?: () => void; control?: boolean }) {
  const read = () => (typeof props.value === 'function' ? props.value() : props.value);
  return (
    <View
      role={props.onPress ? 'button' : undefined}
      onPress={props.onPress}
      activeStyle={props.onPress ? { backgroundColor: alpha(colors.mutedForeground(), 0.06) } : undefined}
      style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}
    >
      <Text style={{ flex: 1, fontSize: fontSize.label, color: colors.foreground() }}>{props.label}</Text>
      <If when={!!read()}>
        <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 1, paddingRight: props.control ? 6 : 0 }}>
          {read() ?? ''}
        </Text>
      </If>
      <If when={!!props.onPress}>
        <Icon name="arrow-right-s" size={16} tone="muted" />
      </If>
    </View>
  );
}

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
  const agent = signal(selected?.agent ?? '');
  const mode = signal<'continuous' | 'stateless'>(selected?.mode ?? 'continuous');
  const workspacePath = signal(selected?.workspacePath ?? '');
  const pinned = signal(!!selected?.pinnedAt);
  const enabled = signal(selected?.enabled ?? true);
  const busy = signal(false);
  const failure = signal('');
  const savedNote = signal('');
  const picker = signal<Picker>(null);
  const channel = signal<ChannelID | null>(null);
  const tasks = signal<AssistantTask[] | null>(null);
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
    } catch {
      tasks.set([]);
    }
  };
  if (!creating && !tasks()) {
    void loadChannels();
    void loadTasks();
  }

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

  const agentChoices = (): Choice<string>[] => [
    { value: '', label: t('settings.switch.off') },
    ...agents().map((entry) => ({ value: entry.name, label: entry.name, description: entry.description })),
  ];

  const workspaceChoices = (): Choice<string>[] => [
    { value: '', label: t('assistants.settings.workspacePlaceholder') },
    ...assistantsWorkspaceOptions(),
  ];

  const save = async () => {
    if (busy()) return;
    if (!name().trim() || !providerID() || !modelID()) {
      failure.set(t('assistants.settings.validation.required'));
      return;
    }
    busy.set(true);
    failure.set('');
    savedNote.set('');
    try {
      await saveAssistant(selected, {
        name: name().trim(),
        avatarSeed: avatarSeed(),
        defaultPrompt: prompt(),
        workspacePath: workspacePath() || null,
        providerID: providerID(),
        modelID: modelID(),
        agent: agent() || null,
        mode: mode(),
        pinned: pinned(),
        enabled: enabled(),
      });
      savedNote.set(t('assistants.settings.toast.saved'));
      activeStack().pop();
    } catch (error) {
      failure.set(errorText(error));
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
      await loadAssistants(true);
      activeStack().pop();
    } catch (error) {
      failure.set(errorText(error));
    }
  };

  const title = creating ? t('assistants.settings.create') : selected ? assistantTitle(selected) : t('assistants.title');

  return (
    <NavPage
      title={title}
      headerBackTitle={t('assistants.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
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
          <View style={{ alignItems: 'center', gap: 8, paddingVertical: 8 }}>
            <View testID="assistant-avatar" role="button" onPress={() => avatarSeed.set(Math.random().toString(36).slice(2, 10))}>
              <AssistantAvatar seed={avatarSeed()} size={72} label={name() || title} />
            </View>
            <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
              {t('assistants.settings.randomAvatar')}
            </Text>
          </View>

          <View style={{ gap: 8 }}>
            <Text style={{ paddingHorizontal: 6, fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
              {t('assistants.settings.name')}
            </Text>
            <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.9) }}>
              <Input
                testID="assistant-name"
                value={name()}
                onChange={(event) => name.set(event.value)}
                placeholder={t('assistants.settings.name')}
                style={{ minHeight: 48, paddingHorizontal: 14, fontSize: 16, color: colors.foreground(), placeholderColor: colors.mutedForeground() }}
              />
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <Text style={{ paddingHorizontal: 6, fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
              {t('assistants.settings.defaultPrompt')}
            </Text>
            <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.9), padding: 6 }}>
              <Input
                testID="assistant-prompt"
                value={prompt()}
                onChange={(event) => prompt.set(event.value)}
                placeholder={t('assistants.settings.defaultPromptPlaceholder')}
                multiline
                style={{ minHeight: 96, padding: 10, fontSize: 15, color: colors.foreground(), placeholderColor: colors.mutedForeground() }}
              />
            </View>
          </View>

          <View style={{ borderRadius: radius.inset, overflow: 'hidden', borderWidth: 1, borderColor: colors.border() }}>
            <Row label={t('assistants.settings.model')} value={modelLabel} onPress={() => picker.set('model')} />
            <Row
              label={t('assistants.settings.agent')}
              value={() => agent() || t('settings.switch.off')}
              onPress={() => picker.set('agent')}
            />
            <Row
              label={t('assistants.settings.mode')}
              value={() => t(mode() === 'stateless' ? 'assistants.mode.stateless' : 'assistants.mode.continuous')}
              onPress={() => picker.set('mode')}
            />
            <Row
              label={t('assistants.settings.workspace')}
              value={() => workspacePath() || t('assistants.settings.workspacePlaceholder')}
              onPress={() => picker.set('workspace')}
            />
            <Row
              label={t('assistants.menu.pin')}
              value={() => (pinned() ? t('assistants.menu.unpin') : t('assistants.menu.pin'))}
              onPress={() => pinned.set(!pinned())}
            />
            <Row
              label={t('assistants.settings.instanceEnabled')}
              value={() => (enabled() ? t('settings.switch.on') : t('settings.switch.off'))}
              onPress={() => enabled.set(!enabled())}
            />
          </View>

          <If when={!!(failure() || savedNote())}>
            <Text style={{ fontSize: fontSize.entityMeta, color: failure() ? colors.destructive() : colors.success() }}>
              {failure() || savedNote()}
            </Text>
          </If>

          <PrimaryButton label={() => t('assistants.settings.save')} busy={busy} onPress={() => void save()} />

          <If when={!creating}>
            <View style={{ gap: 8 }}>
              <Text style={{ paddingHorizontal: 6, fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                {t('assistants.channels.title')}
              </Text>
              <View style={{ borderRadius: radius.inset, overflow: 'hidden', borderWidth: 1, borderColor: colors.border() }}>
                <Each of={['wechat', 'wecom', 'feishu', 'dingtalk'] as ChannelID[]} key="index">
                  {(entry) => (
                    <Row
                      label={
                        entry() === 'wechat'
                          ? t('assistants.weixin.title')
                          : entry() === 'wecom'
                            ? t('assistants.channels.wecom.title')
                            : entry() === 'feishu'
                              ? t('assistants.channels.feishu.title')
                              : t('assistants.channels.dingtalk.title')
                      }
                      value={() => channelStatusLabel(channelLabels()[entry()] ?? '')}
                      onPress={() => channel.set(entry())}
                    />
                  )}
                </Each>
              </View>
            </View>

            <View style={{ gap: 8 }}>
              <Text style={{ paddingHorizontal: 6, fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                {t('assistants.settings.scheduledTasks.title')}
              </Text>
              <View style={{ borderRadius: radius.inset, overflow: 'hidden', borderWidth: 1, borderColor: colors.border() }}>
                <If when={(tasks() ?? []).length === 0}>
                  <Row label={t('assistants.settings.scheduledTasks.empty')} />
                </If>
                <Each of={tasks() ?? []} key={(task) => `${task.projectID}:${task.taskID}`}>
                  {(task) => (
                    <Row
                      label={task().name}
                      value={() => taskStatusLabel(task().lastStatus)}
                      onPress={() =>
                        openScheduledRuns({
                          projectId: task().projectID,
                          taskId: task().taskID,
                          title: task().name,
                        })
                      }
                    />
                  )}
                </Each>
              </View>
            </View>

            <View style={{ borderRadius: radius.inset, overflow: 'hidden', borderWidth: 1, borderColor: colors.border() }}>
              <View
                role="button"
                onPress={() => void remove()}
                activeStyle={{ backgroundColor: alpha(colors.destructive(), 0.08) }}
                style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}
              >
                <Icon name="delete-bin" size={17} color={() => colors.destructive()} />
                <Text style={{ flex: 1, fontSize: fontSize.label, color: colors.destructive() }}>
                  {t('assistants.settings.delete')}
                </Text>
              </View>
            </View>
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
        open={() => picker() === 'agent'}
        title={t('assistants.settings.agent')}
        options={agentChoices}
        value={() => agent()}
        onSelect={(value) => agent.set(value)}
        onClose={() => picker.set(null)}
      />
      <ChoiceSheet
        open={() => picker() === 'mode'}
        title={t('assistants.settings.mode')}
        options={() => [
          { value: 'continuous', label: t('assistants.mode.continuous') },
          { value: 'stateless', label: t('assistants.mode.stateless') },
        ]}
        value={() => mode()}
        onSelect={(value) => mode.set(value)}
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
