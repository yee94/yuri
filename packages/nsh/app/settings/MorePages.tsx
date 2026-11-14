import { Scroll, Text, View, resource, signal } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { ChoiceSheet, QuietButton, Surface, fontSize } from '../core/ui';
import { list, record, request, textOf } from '../core/host';
import { loadSettings, saveSettings, settingsDocument, settingsFlag, settingsText } from '../core/config';
import { normalizePath, projects, sessionsByDirectory } from '../core/store';
import { assistantTitle, assistants, loadAssistants } from '../assistant/data';
import { openAssistantSettings, openSession, tabBarInset } from '../shell/nav';
import { Group, Loading, Row, SwitchRow } from './ui';

type DataRow = { label: string; description?: string; value?: string; id?: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const Page = (props: { titleKey: Parameters<typeof t>[0]; children?: import('nsh').JSX.Element }) => (
  <NavPage
    title={t(props.titleKey)}
    headerBackTitle={t('mobile.settings.placeholder.title')}
    hidesBottomBarWhenPushed
    class="flex-1"
    style={{ backgroundColor: colors.background() }}
  >
    <Scroll class="flex-1" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
      <View style={{ width: '100%', maxWidth: 452, alignSelf: 'center', paddingHorizontal: space.pageInset, gap: 20, paddingTop: 8 }}>
        {props.children}
      </View>
    </Scroll>
  </NavPage>
);

const Body = (props: {
  title: string;
  rows: () => DataRow[];
  loading: () => boolean;
  error: () => string;
  retry: () => void;
  onPress?: (row: DataRow) => void;
}) => (
  <View style={{ gap: 20 }}>
    <If when={!!props.error()}>
      <Surface style={{ padding: 14, gap: 8 }}>
        <Text style={{ fontSize: 13, color: colors.destructive() }}>{props.error()}</Text>
        <QuietButton label={() => t('assistants.actions.retry')} onPress={props.retry} />
      </Surface>
    </If>
    <Group label={props.title}>
      <If when={props.loading() && props.rows().length === 0}>
        <Loading />
      </If>
      <If when={!props.loading() && props.rows().length === 0}>
        <View style={{ paddingVertical: 18, alignItems: 'center' }}>
          <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>{t('common.unavailable')}</Text>
        </View>
      </If>
      <Each of={props.rows()} key={(row) => row.id ?? row.label}>
        {(row) => (
          <Row
            label={() => row().label}
            description={() => row().description ?? ''}
            value={() => row().value ?? ''}
            onPress={props.onPress ? () => props.onPress!(row()) : undefined}
          />
        )}
      </Each>
    </Group>
  </View>
);

function ResourcePage(props: { titleKey: Parameters<typeof t>[0]; load: () => Promise<DataRow[]> }) {
  const data = resource(async () => props.load());
  return (
    <Page titleKey={props.titleKey}>
      <Body
        title={t(props.titleKey)}
        rows={() => data() ?? []}
        loading={() => data.loading()}
        error={() => (data.error() ? errorText(data.error()) : '')}
        retry={() => data.refetch()}
      />
    </Page>
  );
}

export const CommandsSettingsPage = () => (
  <ResourcePage
    titleKey="settings.page.commands.title"
    load={async () =>
      list(await request('/api/command')).map((row) => ({
        label: textOf(row.name) || textOf(row.id),
        description: textOf(row.description),
        id: textOf(row.name) || textOf(row.id),
      }))
    }
  />
);

export const McpSettingsPage = () => (
  <ResourcePage
    titleKey="settings.page.mcp.title"
    load={async () =>
      list(await request('/api/config/mcp')).map((row) => ({
        label: textOf(row.name) || textOf(row.id),
        description: textOf(row.type) || textOf(row.command) || textOf(row.url),
        value: row.enabled === false ? t('settings.switch.off') : t('settings.switch.on'),
        id: textOf(row.name) || textOf(row.id),
      }))
    }
  />
);

export const PluginsSettingsPage = () => (
  <ResourcePage
    titleKey="settings.page.plugins.title"
    load={async () => {
      const value = record(await request('/api/config/plugins'));
      return list(value.entries).map((row) => ({
        label: textOf(row.spec) || textOf(row.name) || textOf(row.id),
        description: textOf(row.source) || textOf(row.path),
        value: row.enabled === false ? t('settings.switch.off') : t('settings.switch.on'),
        id: textOf(row.spec) || textOf(row.name) || textOf(row.id),
      }));
    }}
  />
);

export const SkillsSettingsPage = () => (
  <ResourcePage
    titleKey="settings.page.skills.title"
    load={async () => {
      const value = record(await request('/api/config/skills?summary=true'));
      return list(value.skills).map((row) => ({
        label: textOf(row.name),
        description: textOf(row.description) || textOf(row.path),
        value: textOf(row.scope),
        id: textOf(row.name) || textOf(row.path),
      }));
    }}
  />
);

export const UsageSettingsPage = () => (
  <ResourcePage
    titleKey="settings.page.usage.title"
    load={async () => {
      const value = record(await request('/api/quota/magpie'));
      return list(value.sources).map((row) => ({
        label: textOf(row.name) || textOf(row.id),
        description: textOf(row.error),
        value: String(list(row.results).length),
        id: textOf(row.id),
      }));
    }}
  />
);

export function ProjectsSettingsPage() {
  return (
    <Page titleKey="settings.page.projects.title">
      <Group label={t('settings.page.projects.title')}>
        <If when={projects().length === 0}>
          <Row label={t('mobile.sessions.empty.noProjectsTitle')} />
        </If>
        <Each of={projects()} key={(project) => project.id}>
          {(project) => <Row label={() => project().label} description={() => project().path} />}
        </Each>
      </Group>
    </Page>
  );
}

/** `/settings/assistants`: the bots this instance exposes, each opening its editor. */
export function AssistantsSettingsListPage() {
  if (assistants().length === 0) void loadAssistants();
  const headerRight = (
    <Button
      testID="assistants-create"
      onPress={() => openAssistantSettings('new')}
      accessibilityLabel={t('assistants.settings.create')}
      style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ fontSize: 15, fontWeight: '600', color: colors.foreground() }}>{t('assistants.settings.create')}</Text>
    </Button>
  );
  return (
    <NavPage
      title={t('assistants.title')}
      headerBackTitle={t('mobile.settings.placeholder.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerRight={headerRight}
    >
      <Scroll class="flex-1" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
        <View style={{ width: '100%', maxWidth: 452, alignSelf: 'center', paddingHorizontal: space.pageInset, gap: 20, paddingTop: 8 }}>
          <Group label={t('assistants.settings.listTitle')}>
            <If when={assistants().length === 0}>
              <Row label={t('assistants.settings.empty')} />
            </If>
            <Each of={assistants()} key={(assistant) => assistant.id}>
              {(assistant) => (
                <Row
                  testID={`settings-assistant-${assistant().id}`}
                  label={() => assistantTitle(assistant())}
                  description={() => (assistant().providerID ? `${assistant().providerID} · ${assistant().modelID}` : '')}
                  icon="robot-2"
                  onPress={() => openAssistantSettings(assistant().id)}
                />
              )}
            </Each>
          </Group>
        </View>
      </Scroll>
    </NavPage>
  );
}

const configEntries = (prefix: string): DataRow[] => {
  const document = settingsDocument() ?? {};
  return Object.keys(document)
    .filter((key) => key.toLowerCase().startsWith(prefix))
    .filter((key) => typeof document[key] !== 'object')
    .map((key) => ({ label: key, value: String(document[key]), id: key }));
};

/** A page whose entries are the Host settings document keys under one prefix. */
export function ConfigPrefixPage(props: { titleKey: Parameters<typeof t>[0]; prefix: string }) {
  if (!settingsDocument()) void loadSettings();
  return (
    <Page titleKey={props.titleKey}>
      <Group label={t(props.titleKey)}>
        <If when={configEntries(props.prefix).length === 0}>
          <Row label={t('common.unavailable')} />
        </If>
        <Each of={configEntries(props.prefix)} key={(row) => row.id ?? row.label}>
          {(row) => <Row label={() => row().label} value={() => row().value ?? ''} />}
        </Each>
      </Group>
    </Page>
  );
}

export function ChatSettingsPage() {
  if (!settingsDocument()) void loadSettings();
  const flag = (key: string, fallback: boolean) => settingsFlag(key, fallback);
  const save = (key: string, value: boolean) => void saveSettings({ [key]: value });
  return (
    <Page titleKey="settings.page.chat.title">
      <Group label={t('settings.page.chat.title')}>
        <SwitchRow
          label={t('settings.yuri.visual.field.showReasoningTraces')}
          description={t('settings.yuri.visual.field.showReasoningTracesHint')}
          checked={() => flag('showReasoningTraces', true)}
          onChange={(value) => save('showReasoningTraces', value)}
        />
        <SwitchRow
          label={t('settings.yuri.visual.field.codeBlockLineWrap')}
          checked={() => flag('codeBlockLineWrap', false)}
          onChange={(value) => save('codeBlockLineWrap', value)}
        />
        <SwitchRow
          label={t('settings.yuri.visual.field.showAssistantTps')}
          description={t('settings.yuri.visual.field.showAssistantTpsTooltip')}
          checked={() => flag('showAssistantTps', false)}
          onChange={(value) => save('showAssistantTps', value)}
        />
        <SwitchRow
          label={t('settings.yuri.visual.field.showSplitAssistantMessageActions')}
          description={t('settings.yuri.visual.field.showSplitAssistantMessageActionsTooltip')}
          checked={() => flag('showSplitAssistantMessageActions', false)}
          onChange={(value) => save('showSplitAssistantMessageActions', value)}
        />
        <SwitchRow
          label={t('settings.yuri.visual.field.showSubagentTaskDetails')}
          description={t('settings.yuri.visual.field.showSubagentTaskDetailsHint')}
          checked={() => flag('showSubagentTaskDetails', false)}
          onChange={(value) => save('showSubagentTaskDetails', value)}
        />
        <SwitchRow
          label={t('settings.yuri.visual.field.enableSpellcheckInTextInputs')}
          checked={() => flag('inputSpellcheckEnabled', false)}
          onChange={(value) => save('inputSpellcheckEnabled', value)}
        />
      </Group>
    </Page>
  );
}

export function SessionsSettingsPage() {
  if (!settingsDocument()) void loadSettings();
  const picker = signal(false);
  const action = () => (settingsText('sessionRetentionAction') === 'delete' ? 'delete' : 'archive');
  return (
    <Page titleKey="settings.page.sessions.title">
      <Group label={t('settings.yuri.sessionRetention.title')}>
        <SwitchRow
          label={t('settings.yuri.sessionRetention.field.enableAutoCleanup')}
          description={t('settings.yuri.sessionRetention.tooltip')}
          checked={() => settingsFlag('autoDeleteEnabled', false)}
          onChange={(value) => void saveSettings({ autoDeleteEnabled: value })}
        />
        <Row
          label={t('settings.yuri.sessionRetention.field.retentionPeriod')}
          value={() => `${settingsText('autoDeleteAfterDays') || '30'} ${t('settings.yuri.sessionRetention.field.days')}`}
        />
        <Row
          testID="sessions-retention-action"
          label={t('settings.yuri.sessionRetention.field.whenSessionsExpire')}
          value={() =>
            t(
              action() === 'delete'
                ? 'settings.yuri.sessionRetention.action.delete'
                : 'settings.yuri.sessionRetention.action.archive',
            )
          }
          onPress={() => picker.set(true)}
        />
      </Group>
      <ChoiceSheet
        open={picker}
        title={t('settings.yuri.sessionRetention.field.whenSessionsExpire')}
        options={() => [
          { value: 'archive', label: t('settings.yuri.sessionRetention.action.archive') },
          { value: 'delete', label: t('settings.yuri.sessionRetention.action.delete') },
        ]}
        value={action}
        onSelect={(value) => void saveSettings({ sessionRetentionAction: value })}
        onClose={() => picker.set(false)}
      />
    </Page>
  );
}

/** `/settings/behavior`: the global AGENTS.md rules the Host applies to every session. */
export function BehaviorSettingsPage() {
  if (!settingsDocument()) void loadSettings();
  const document = resource(async () => record(await request('/api/behavior/agents-md')));
  const content = () => textOf(document()?.content).trim();
  return (
    <Page titleKey="settings.page.behavior.title">
      <Group label={t('settings.behavior.page.section.systemPrompt')}>
        <If when={document.loading() && !document()}>
          <Loading />
        </If>
        <If when={!!document.error()}>
          <View style={{ paddingVertical: 18, alignItems: 'center' }}>
            <Text style={{ fontSize: fontSize.entityMeta, color: colors.destructive() }}>{errorText(document.error())}</Text>
            <QuietButton label={() => t('assistants.actions.retry')} onPress={() => document.refetch()} />
          </View>
        </If>
        <If when={!document.loading() && !content() && !document.error()}>
          <Row label={t('settings.behavior.page.field.systemPromptPlaceholder')} />
        </If>
        <If when={!!content()}>
          <Row
            label={t('settings.behavior.page.section.systemPrompt')}
            description={() => content().slice(0, 600)}
          />
        </If>
      </Group>
      <Group label={t('settings.behavior.page.warning.title')}>
        <Row
          label={t('settings.behavior.page.warning.title')}
          description={() => t('settings.behavior.page.warning.description', { path: '~/.config/opencode/AGENTS.md' })}
        />
      </Group>
    </Page>
  );
}

export function GitSettingsPage() {  if (!settingsDocument()) void loadSettings();
  const picker = signal(false);
  const mode = () => (settingsText('gitChangesViewMode') === 'flat' ? 'flat' : 'tree');
  return (
    <Page titleKey="settings.page.git.title">
      <Group label={t('settings.page.git.title')}>
        <Row
          testID="git-changes-view"
          label={t('settings.yuri.git.changesViewTitle')}
          value={() => t(mode() === 'flat' ? 'settings.yuri.git.option.flatList' : 'settings.yuri.git.option.treeView')}
          onPress={() => picker.set(true)}
        />
      </Group>
      <ChoiceSheet
        open={picker}
        title={t('settings.yuri.git.changesViewTitle')}
        options={() => [
          { value: 'flat', label: t('settings.yuri.git.option.flatList') },
          { value: 'tree', label: t('settings.yuri.git.option.treeView') },
        ]}
        value={mode}
        onSelect={(value) => void saveSettings({ gitChangesViewMode: value })}
        onClose={() => picker.set(false)}
      />
    </Page>
  );
}

export function ArchivedSessionsSettingsPage() {
  const rows = (): DataRow[] => {
    const out: DataRow[] = [];
    for (const [directory, sessions] of sessionsByDirectory()) {
      for (const session of sessions) {
        if (!session.archived) continue;
        out.push({
          label: session.title.trim() || session.id,
          description: normalizePath(directory),
          id: session.id,
        });
      }
    }
    return out;
  };
  return (
    <Page titleKey="settings.page.archivedSessions.title">
      <Group label={t('settings.page.archivedSessions.title')}>
        <If when={rows().length === 0}>
          <Row label={t('sessions.sidebar.empty.noMatches.title')} />
        </If>
        <Each of={rows()} key={(row) => row.id ?? row.label}>
          {(row) => (
            <Row
              label={() => row().label}
              description={() => row().description ?? ''}
              onPress={() =>
                openSession({ id: row().id ?? '', title: row().label, directory: row().description ?? '' })
              }
            />
          )}
        </Each>
      </Group>
    </Page>
  );
}
