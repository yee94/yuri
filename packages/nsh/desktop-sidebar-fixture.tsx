import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { DesktopSidebar } from './desktop-sidebar';
import { app, epoch, loadConnections, observeRuntime } from './state';
import { desktopSidebarScope } from './desktop-sidebar-model';
import { desktopSidebarSessionStateKey } from './desktop-sidebar-projection';
import { request } from './runtime';
import { language } from './i18n';
import type { ChatTarget } from './model';
import type { DesktopSidebarActionsRef } from './desktop-sidebar-navigation';
import type { DesktopSwitcherSource } from './desktop-session-switcher-core';

// Synthetic desktop-only entry. No production application or touch navigation changes.
language.set('en');
function Fixture() {
  const active = signal(true), selected = signal<ChatTarget | null>(null), action = signal(''), audit = signal('');
  const visible = signal(true), installations = signal(0), ownerReady = signal(false);
  const project = { id: 'project', name: 'Desktop workspace', path: '/workspace' };
  let lastSource: DesktopSwitcherSource | undefined;
  const actions: DesktopSidebarActionsRef = { current: null, set: owner => { if (owner) lastSource = owner.switcherSource; installations.set(installations() + 1); ownerReady.set(owner !== null); } };
  void loadConnections().then(() => app.projects.set([project]));
  observeRuntime(() => {});
  return <View class="flex-1 flex-row">
    <View style={{ width: 260 }}><DesktopSidebar authority={{ scope: desktopSidebarScope(app.connection(), epoch()) ?? '', sessions: new Map(['head', 'child-z'].map(id => [desktopSidebarSessionStateKey({ id, directory: '/workspace' }), { hasChildren: true }])) }} active={active()} visible={visible()} actionsRef={actions} selectedTarget={selected()} navigation={{
      onOpenChat: target => { selected.set(target); action.set(`chat:${target.id}`); },
      onOpenProject: () => action.set('project'), onOpenFiles: directory => action.set(`files:${directory}`),
      onOpenChanges: directory => action.set(`changes:${directory}`), onAddProject: () => action.set('add-project'),
      onEditProject: () => action.set('edit-project'), onNewWorktree: () => action.set('new-worktree'),
      onOpenArchivedSessions: () => action.set('archives'),
    }} onNewSessionInFolder={(project, folder) => action.set(`folder-draft:${JSON.stringify([project.path, folder.scope, folder.id])}`)} onNewSession={project => action.set(`draft:${project?.path ?? 'global'}`)} onAssistants={() => action.set('assistants')}
      onSchedules={() => action.set('schedules')} onSettings={() => action.set('settings')} onConnections={() => action.set('connections')}
      onSearch={() => action.set('search')} onSessionSwitcher={() => action.set('switcher')} /></View>
    <View class="flex-1 p-4 gap-2"><Text testID="desktop-fixture-action">{action()}</Text>
      <Text testID="desktop-fixture-host-label">{app.connection()?.label}</Text>
      <Button testID="desktop-fixture-search" onPress={() => action.set('search')}><Text>Synthetic shell search</Text></Button>
      <Button testID="desktop-fixture-active" onPress={() => active.set(!active())}><Text>Toggle synthetic sidebar</Text></Button>
      <Button testID="desktop-fixture-visible" onPress={() => visible.set(!visible())}><Text>Toggle synthetic rows</Text></Button>
      <Text>{`owner:${ownerReady()}:${installations()}`}</Text>
      <Button testID="desktop-fixture-tree-data" onPress={() => { void request('/fixture/tree-data').then(() => action.set('tree-data-ready')); }}><Text>Enable synthetic tree data</Text></Button>
      <Button testID="desktop-fixture-add-project" onPress={() => { void request('/fixture/add-project').then(() => { app.projects.set([...app.projects(), { id: 'other-project', path: '/other-project', name: 'Other project' }]); action.set('project-added'); }); }}><Text>Add synthetic project</Text></Button>
      <Button testID="desktop-fixture-host" onPress={() => app.connection.set({ id: 'other', label: 'Other Host', url: 'https://other.example', lastUsedAt: 0 })}><Text>Switch synthetic Host</Text></Button>
      <Button testID="desktop-fixture-audit" onPress={() => { void request('/fixture/audit').then(result => audit.set(JSON.stringify(result))); }}><Text>Inspect synthetic audit</Text></Button>
      <Button testID="desktop-fixture-read-failure" onPress={() => { void request('/fixture/read-failure').then(() => action.set('read-failure-armed')); }}><Text>Fail synthetic catalog read</Text></Button>
      <Button testID="desktop-fixture-burst" onPress={() => { void request('/fixture/burst').then(() => action.set('burst-delivered')); }}><Text>Send synthetic token burst</Text></Button>
      <Button testID="desktop-fixture-number-one" onPress={() => { actions.current?.numbered(1); }}><Text>Synthetic slot one</Text></Button>
      <Button testID="desktop-fixture-next" onPress={() => { actions.current?.adjacent(1); }}><Text>Synthetic next</Text></Button>
      <Button testID="desktop-fixture-previous" onPress={() => { actions.current?.adjacent(-1); }}><Text>Synthetic previous</Text></Button>
      <Button testID="desktop-fixture-targets" onPress={() => action.set(`targets:${JSON.stringify(actions.current?.targets().map(target => [target.context, target.sessionId]) ?? [])}`)}><Text>Synthetic logical rows</Text></Button>
      <Button testID="desktop-fixture-source" onPress={() => {
        const source = actions.current?.switcherSource ?? lastSource, snapshot = source?.snapshot();
        action.set(`source:${JSON.stringify(snapshot ? { ...snapshot, branches: [...snapshot.branches ?? []], statuses: snapshot.sessions.map(row => [row.id, source?.status?.(row)]) } : null)}`);
      }}><Text>Inspect retained switcher source</Text></Button>
      <Button testID="desktop-fixture-source-retry" onPress={() => { void actions.current?.switcherSource.retry?.().then(() => action.set('source-retried')); }}><Text>Retry retained source</Text></Button>
      <Each of={['order-fail', 'order-lost-ack', 'tree-fail', 'tree-lost-ack', 'delete-fail', 'documents-lost-ack', 'documents-cancelled', 'archived-pages', 'archived-page-fail']}>{mode => <Button testID={`desktop-fixture-${mode()}`} onPress={() => { void request(`/fixture/${mode()}`).then(() => action.set(mode())); }}><Text>{mode()}</Text></Button>}</Each>
      <Text testID="desktop-fixture-audit-result">{audit()}</Text>
    </View>
  </View>;
}
mount(Fixture);
