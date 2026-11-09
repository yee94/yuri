import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { DesktopSidebar, type DesktopSidebarProps } from './desktop-sidebar';
import { app, epoch, loadConnections } from './state';
import { desktopSidebarScope } from './desktop-sidebar-model';
import { desktopSidebarSessionStateKey } from './desktop-sidebar-projection';
import { language } from './i18n';
import type { DesktopSidebarActionsRef } from './desktop-sidebar-navigation';
import { request } from './runtime';

// Independent synthetic UI fixture: only the explicit test Host supplies data.
language.set('en');
function Fixture() {
  const active = signal(true), visible = signal(true), shortcuts = signal(false), action = signal('');
  const interactive = signal(true), installations = signal(0), ownerReady = signal(false), audit = signal(''), source = signal('');
  const actions: DesktopSidebarActionsRef = { current: null, set: owner => { installations.set(installations() + 1); ownerReady.set(!!owner); } };
  const section = signal<DesktopSidebarProps['selectedSection']>('chat');
  void loadConnections().then(() => app.projects.set([{ id: 'project', name: 'Desktop workspace', path: '/workspace' }]));
  const choose = (value: DesktopSidebarProps['selectedSection']) => { section.set(value); action.set(value ?? ''); };
  return <View class="flex-1 bg-background">
    <View class="flex-row items-center" style={{ height: 48 }}>
      <Text style={{ width: 180 }}>Yuri</Text>
      <Button testID="fixture-titlebar-search" onPress={() => action.set('search')}><Text>Search</Text></Button>
      <Button testID="fixture-titlebar-switcher" onPress={() => action.set('switcher')}><Text>Switch</Text></Button>
    </View>
    <View class="flex-1 flex-row min-h-0">
      <View style={{ width: 260 }}><DesktopSidebar authority={{ scope: desktopSidebarScope(app.connection(), epoch()) ?? '', sessions: new Map([[desktopSidebarSessionStateKey({ id: 'head', directory: '/workspace' }), { hasChildren: true }]]) }} active={active()} interactive={interactive()} visible={visible()} actionsRef={actions} selectedSection={section()} navigation={{
        onOpenChat: target => action.set(`chat:${target.id}`), onOpenProject: () => action.set('project'),
        onOpenFiles: () => action.set('files'), onOpenChanges: () => action.set('changes'),
        onAddProject: () => action.set('add-project'), onEditProject: () => action.set('edit-project'),
        onOpenArchivedSessions: () => action.set('archives'),
      }} onNewSession={() => action.set('draft')} onAssistants={() => choose('assistants')}
        onSchedules={() => choose('schedules')} onSettings={() => choose('settings')} onConnections={() => choose('connections')}
        onSearch={() => action.set('unexpected-sidebar-search')} onSessionSwitcher={() => action.set('unexpected-sidebar-switcher')}
        onShortcuts={shortcuts() ? () => action.set('help-dialog') : undefined} /></View>
      <View class="flex-1 p-4 gap-2">
        <Text testID="fixture-chrome-action">{action()}</Text>
        <Button testID="fixture-help-owner" onPress={() => shortcuts.set(!shortcuts())}><Text>Toggle help owner</Text></Button>
        <Button testID="fixture-sidebar-visible" onPress={() => visible.set(!visible())}><Text>Toggle visibility</Text></Button>
        <Button testID="fixture-sidebar-active" onPress={() => active.set(!active())}><Text>Toggle activity</Text></Button>
        <Button testID="fixture-sidebar-interactive" onPress={() => interactive.set(!interactive())}><Text>Toggle modal admission</Text></Button>
        <Text>{`owner:${ownerReady()}:${installations()}`}</Text>
        <Button testID="fixture-sidebar-source" onPress={() => {
          const value = actions.current?.switcherSource.snapshot();
          source.set(JSON.stringify(value ? { ready: value.ready, sessions: value.sessions.map(row => row.id), projects: value.projects.map(row => row.id) } : null));
        }}><Text>Read retained source</Text></Button>
        <Button testID="fixture-sidebar-numbered" onPress={() => action.set(`numbered:${actions.current?.numbered(1) ?? false}`)}><Text>Invoke numbered navigation</Text></Button>
        <Button testID="fixture-sidebar-audit" onPress={() => { void request('/fixture/audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Read synthetic requests</Text></Button>
        <Text testID="fixture-sidebar-source-value" style={{ numberOfLines: 1 }}>{`source:${source()}`}</Text>
        <Text testID="fixture-sidebar-audit-value" style={{ numberOfLines: 1 }}>{`audit:${audit()}`}</Text>
      </View>
    </View>
  </View>;
}
mount(Fixture);
