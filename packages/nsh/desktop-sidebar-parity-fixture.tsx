import { computed, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { DesktopSidebar } from './desktop-sidebar';
import { app, epoch, loadConnections } from './state';
import { desktopSidebarScope } from './desktop-sidebar-model';
import { desktopSidebarSessionStateKey, type DesktopSidebarAuthority, type DesktopSidebarContact } from './desktop-sidebar-projection';
import { projectsAttention } from './projects-attention';
import { request } from './runtime';
import { language } from './i18n';
import type { ChatTarget } from './model';

language.set('en');
const contact = (id: string, createdAt: number, extra: Partial<DesktopSidebarContact> = {}): DesktopSidebarContact => ({ id, enabled: true, working: false, activeContactTurn: null, latestMessagePreview: { createdAt, messageID: id, ordinal: 1, role: 'assistant', text: '', fallbackKind: null }, ...extra });
function Fixture() {
  const mode = signal('missing'), interactive = signal(true), action = signal(''), audit = signal('');
  const selected = signal<ChatTarget | null>({ kind: 'session', id: 'head', directory: '/workspace', title: 'Synthetic selection' });
  const scope = () => desktopSidebarScope(app.connection(), epoch()) ?? '';
  const attentionKey = () => JSON.stringify([epoch(), app.connection()?.id]);
  const projection = computed<DesktopSidebarAuthority | null>(() => mode() === 'missing' ? null : ({
    scope: mode() === 'stale' ? 'retired-authority' : scope(),
    assistants: { enabled: mode() !== 'disabled', contacts: [contact('older', 1, { working: mode() !== 'idle', unreadCount: 102 }), contact('latest', 20, { avatarSeed: 'saved-synthetic-artwork' }), contact('disabled', 100, { enabled: false, unreadCount: 20 })] },
    schedules: [{ task: { lastStatus: mode() === 'idle' ? 'success' : 'running' } }],
    sessions: new Map([[desktopSidebarSessionStateKey({ id: 'head', directory: '/workspace' }), { hasChildren: true, unreadCount: 1, navigationRunning: mode() !== 'idle' }]]),
  }));
  void loadConnections().then(() => { app.projects.set([{ id: 'project', name: 'Desktop workspace', path: '/workspace' }]); projectsAttention.activate(attentionKey()); });
  function blocking(question: boolean, permission: boolean) {
    const key = attentionKey();
    projectsAttention.ingestBlocking(key, { key: 'global', type: question ? 'question.asked' : 'question.replied', directory: '/workspace', body: { id: 'synthetic-question', sessionID: 'head' } }, '/workspace');
    projectsAttention.ingestBlocking(key, { key: 'global', type: permission ? 'permission.asked' : 'permission.replied', directory: '/workspace', body: { id: 'synthetic-permission', sessionID: 'head' } }, '/workspace');
  }
  return <View class="flex-1 flex-row bg-background">
    <View style={{ width: 260 }}><DesktopSidebar active interactive={interactive()} authority={projection()} selectedTarget={selected()} navigation={{ onOpenChat: row => { selected.set(row); action.set(`open:${row.id}`); }, onOpenProject: () => {}, onOpenFiles: () => {}, onOpenChanges: () => {}, onAddProject: () => {}, onEditProject: () => {} }} onNewSession={() => action.set('new')} onAssistants={() => action.set('assistants')} onSchedules={() => action.set('schedules')} onSettings={() => action.set('settings')} onConnections={() => action.set('connections')} onSearch={() => {}} onSessionSwitcher={() => {}} /></View>
    <View class="flex-1 p-4 gap-2">
      <Text>{action()}</Text>
      <Each of={['missing', 'known', 'disabled', 'stale', 'idle']}>{value => <Button testID={`parity-${value()}`} onPress={() => mode.set(value())}><Text>{value()}</Text></Button>}</Each>
      <Button testID="parity-question" onPress={() => blocking(true, true)}><Text>Question and permission</Text></Button>
      <Button testID="parity-permission" onPress={() => blocking(false, true)}><Text>Permission only</Text></Button>
      <Button testID="parity-clear" onPress={() => blocking(false, false)}><Text>Clear blocking</Text></Button>
      <Button testID="parity-modal" onPress={() => interactive.set(!interactive())}><Text>Toggle modal</Text></Button>
      <Button testID="parity-audit" onPress={() => { void request('/fixture/audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Audit</Text></Button>
      <Text>{`audit:${audit()}`}</Text>
    </View>
  </View>;
}
mount(Fixture);
