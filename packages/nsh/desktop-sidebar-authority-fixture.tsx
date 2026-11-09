import { cleanup, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { DesktopSidebar } from './desktop-sidebar';
import { AssistantHome } from './assistants';
import { app, desktopSidebarAuthority, loadConnections, observeRuntime, refresh } from './state';
import { openNativeNewSession, type NativeNewSessionFolderTarget } from './new-session';
import { request } from './runtime';
import { language } from './i18n';

language.set('en');
function Draft(props: { folder: NativeNewSessionFolderTarget }) {
  const owner = openNativeNewSession({ project: { id: 'project', name: 'Workspace', path: '/workspace' }, folder: props.folder, active: () => true });
  const result = signal('');
  cleanup(() => { void owner.close(); });
  return <View class="flex-1 gap-2">
    <Input testID="authority-folder-input" value={owner.durable.draft()} onChange={event => owner.setDraftText(event.value)} />
    <Button testID="authority-folder-send" onPress={() => { void owner.submit().then(receipt => result.set(receipt ? `handoff:${receipt.target.id}:${owner.folder()?.status}` : 'empty')).catch(() => result.set('failed')); }}><Text>Submit draft</Text></Button>
    <Text>{result()}</Text>
  </View>;
}
function Fixture() {
  const showHome = signal(false), folder = signal<NativeNewSessionFolderTarget | null>(null), input = signal(''), audit = signal(''), error = signal('');
  let scans = 0;
  observeRuntime(() => {});
  void loadConnections().then(refresh).then(() => {
    for (const row of app.sessions()) {
      const value = row.hasChildren;
      Object.defineProperty(row, 'hasChildren', { enumerable: true, configurable: true, get: () => { scans++; return value; } });
    }
  }).catch(() => error.set('root-failed'));
  return <View class="flex-1 flex-row bg-background">
    <View style={{ width: 300 }}><DesktopSidebar active authority={desktopSidebarAuthority()}
      navigation={{ onOpenChat: () => {}, onOpenProject: () => {}, onOpenFiles: () => {}, onOpenChanges: () => {}, onAddProject: () => {}, onEditProject: () => {} }}
      onNewSession={() => {}} onNewSessionInFolder={(_project, target) => folder.set(target)} onAssistants={() => {}} onSchedules={() => {}} onSettings={() => {}} onConnections={() => {}} onSearch={() => {}} onSessionSwitcher={() => {}} /></View>
    <View class="flex-1 gap-2 p-4">
      <Text>{error()}</Text>
      <Input testID="authority-unrelated-input" value={input()} onChange={event => input.set(event.value)} />
      <Button testID="authority-start-budget" onPress={() => { scans = 0; }}><Text>Start audit</Text></Button>
      <Button testID="authority-audit" onPress={() => { void request('/fixture/authority-audit').then(value => audit.set(`authority-audit:${scans}:${JSON.stringify(value)}`)); }}><Text>Audit</Text></Button>
      <Text>{audit()}</Text>
      <Button testID="authority-home-disable" onPress={() => { void request('/fixture/authority-disable').then(() => { app.tab.set(1); showHome.set(true); }); }}><Text>Adopt disabled home snapshot</Text></Button>
      <If when={showHome()}><AssistantHome active onOpenChat={() => {}} onCreate={() => {}} onEdit={() => {}} /></If>
      <If when={!!folder()}><Draft folder={folder()!} /></If>
    </View>
  </View>;
}
mount(Fixture);
