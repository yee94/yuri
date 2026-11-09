import { Scroll, signal, Text, View } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { t } from './i18n';
import { messagesFrom, record, text, type Message, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsFeedback, SettingsGroup, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { createSettingsArchiveRestore, settingsObject, settingsRows, visibleArchivedSettingsSession } from './settings-protocol';
import { publishSettingsEditor } from './desktop-settings-publisher';

export function SettingsArchive(props: SettingsCallbacks & SettingsRoute) {
  const state = settingsPageLifetime(), sessions = signal<Row[]>([]), cursor = signal<string | null>(null);

  const selected = signal<Row>({}), messages = signal<Message[]>([]), messageCursor = signal<string | null>(null);
  const selectedProject = signal<string | null>(null);
  publishSettingsEditor({ current: state.current, scope: state.operation, pending: state.busy, dirty: () => false, stamp: () => [] });
  const initial = state.operation();
  const restoreArchive = createSettingsArchiveRestore(initial?.request ?? (async () => { throw new Error('Runtime changed'); }), initial?.current ?? (() => false));
  state.observeOperation(operation => { restoreArchive.replaceLane(operation); if (operation) void load(false, operation); });
  const directory = (session: Row) => text(record(session.location).directory) || text(session.directory);
  async function load(older = false, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      if (props.entity) {
        if (!older) {
          const result = settingsObject(await operation.request(`/api/session/${encodeURIComponent(props.entity)}${props.directory ? `?directory=${encodeURIComponent(props.directory)}` : ''}`));
          if (!operation.current()) return;
          selected.set(settingsObject(result.data ?? result));
        }
        const path = `/api/session/${encodeURIComponent(props.entity)}/message?limit=20&directory=${encodeURIComponent(directory(selected()))}${older && messageCursor() ? `&cursor=${encodeURIComponent(messageCursor() || '')}` : '&order=desc'}`;
        const page = messagesFrom(await operation.request(path), false);
        if (!operation.current()) return;
        messages.set(older ? [...page.messages.filter(item => !messages().some(previous => previous.id === item.id)), ...messages()] : page.messages);
        messageCursor.set(page.cursor);
      } else {
        const body = settingsObject(await operation.request(`/api/session?limit=100&archived=true${older && cursor() ? '&cursor=' + encodeURIComponent(cursor() || '') : ''}`));
        if (!operation.current()) return;
        const rows = settingsRows(body.data).filter(visibleArchivedSettingsSession);
        sessions.set(older ? [...sessions(), ...rows.filter(item => !sessions().some(previous => previous.id === item.id))] : rows);
        cursor.set(text(record(body.cursor).next) || null);
      }
      state.ready.set(true);
    }, operation);
  }
  void load();
  async function restore(session: Row, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    let restored = false;
    await state.perform(async (operation) => {
      try { await restoreArchive(session); }
      catch { throw new Error(t('settings.yuri.archivedSessions.toast.restoreFailed')); }
      sessions.set(sessions().filter(item => item.id !== session.id));
      state.notice.set(t('settings.yuri.archivedSessions.toast.restored'));
      restored = true;
    }, operation);
    if (restored && props.entity && operation.current()) props.onBack();
  }
  const projects = () => [...new Set(sessions().map(directory))];
  return <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={() => { void load(); }} />
    <If when={!props.entity}>
      <Each of={projects().filter(project => selectedProject() === null || selectedProject() === project)}>{project => <SettingsGroup title={project() || t('settings.yuri.archivedSessions.otherProjects')}>
        <If when={selectedProject() === null}><Button class={settingsAction} onPress={() => selectedProject.set(project())}><Text class="text-foreground">{t('settings.yuri.archivedSessions.actions.preview')}</Text></Button></If>
        <If when={selectedProject() !== null}><Each of={sessions().filter(session => directory(session) === project())}>{session => <View class="py-3 gap-2"><Text class="text-base text-foreground">{text(session().title) || text(session().id)}</Text><Button class={settingsAction} onPress={() => props.onOpen({ page: 'archived-sessions', entity: text(session().id), directory: directory(session()) })}><Text class="text-foreground">{t('settings.yuri.archivedSessions.actions.preview')}</Text></Button><Button class={settingsAction} disabled={state.busy()} onPress={() => { void restore(session()); }}><Text class="text-foreground">{t('settings.yuri.archivedSessions.actions.restore')}</Text></Button></View>}</Each></If>
      </SettingsGroup>}</Each>
      <If when={selectedProject() !== null}><Button class={settingsAction} onPress={() => selectedProject.set(null)}><Text class="text-foreground">{t('settings.yuri.archivedSessions.dialog.backToProjects')}</Text></Button></If>
      <If when={!!cursor()}><Button class={settingsAction} disabled={state.busy()} onPress={() => { void load(true); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.loadMore')}</Text></Button></If>
      <If when={state.ready() && !sessions().length}><Text class="text-muted-foreground">{t('settings.yuri.archivedSessions.dialog.empty')}</Text></If>
    </If>
    <If when={!!props.entity}>
      <Text class="text-xl font-semibold text-foreground">{text(selected().title)}</Text>
      <Button class={settingsAction} disabled={state.busy() || !state.ready()} onPress={() => { void restore(selected()); }}><Text class="text-foreground">{t('settings.yuri.archivedSessions.actions.restore')}</Text></Button>
      <If when={!!messageCursor()}><Button class={settingsAction} disabled={state.busy()} onPress={() => { void load(true); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.loadMore')}</Text></Button></If>
      <Each of={messages()}>{message => <SettingsGroup title={message().role}><TextView markdown={message().text} class="text-foreground" selectable /><If when={!!message().reasoning}><TextView markdown={message().reasoning} class="text-muted-foreground" selectable /></If><Each of={message().tools}>{tool => <Text class="text-sm text-muted-foreground">{text(tool().tool)} · {text(tool().status)}</Text>}</Each></SettingsGroup>}</Each>
    </If>
  </Scroll>;
}
