import { cleanup, host, mount, signal, Storage, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { app, createChat, loadConnections } from './state';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from './desktop-panel';
import { createNativeDesktopPanelTabsPersistence } from './desktop-panel-tabs-native';
import { desktopGitDraftAuthority } from './desktop-git-dispatch';
import type { DesktopPanelScope } from './desktop-panel-model';
import type { DesktopPanelChatHandle } from './desktop-panel-chat';
import { native } from './runtime';

function Workbench() {
  const scope: DesktopPanelScope = { host: { ...app.runtimeScope()! }, authorityKey: desktopGitDraftAuthority(app.connection()!), sessionID: 'parent', directory: '/parent' };
  const main = createChat({ kind: 'session', id: 'parent', directory: '/parent', title: 'Parent writer' });
  const tabs = createNativeDesktopPanelTabs({ storage: false }), metadata = createNativeDesktopPanelTabsPersistence(tabs);
  const initialized = signal(false), active = signal(true), modal = signal(false), enabled = signal(host.params.disabled !== true), result = signal(''), files = signal(''), diff = signal(''), counts = signal('');
  const owners = new Map<string, DesktopPanelChatHandle>();
  const owner = () => owners.get(tabs.snapshot(scope).selectedID ?? '');
  let registrations = 0, releases = 0, auditRevision = 0;
  void metadata.ready.then(() => {
    if (!tabs.snapshot(scope).tabs.length) {
      tabs.open(scope, { kind: 'context' }); tabs.open(scope, { kind: 'chat', target: { sessionID: 'parent', directory: '/parent', title: 'Embedded parent' } }); tabs.setRail(scope, null);
    }
    initialized.set(true);
  });
  const current = () => app.connection()?.id === scope.host.hostID && desktopGitDraftAuthority(app.connection()!) === scope.authorityKey;
  const controls = host.on('workbench.control', payload => {
    const action = (payload as { action: string }).action;
    if (action === 'hide') active.set(false);
    if (action === 'show') active.set(true);
    if (action === 'cover') modal.set(true);
    if (action === 'uncover') modal.set(false);
    if (action === 'disable') enabled.set(false);
    if (action === 'other') tabs.open(scope, { kind: 'chat', target: { sessionID: 'other', directory: '/other', title: 'Different workspace' } });
    if (action === 'locate') tabs.open(scope, { kind: 'chat', target: { sessionID: 'parent', directory: '/parent', title: 'Retitled parent', messageID: 'old-parent' } });
    if (action === 'close') { const id = tabs.snapshot(scope).selectedID; if (id) void tabs.requestClose(scope, id); }
    if (action === 'audit') { void metadata.flush().then(() => Storage.getItem('desktop.panel-tabs.v1')).then(raw => counts.set(JSON.stringify({ revision: ++auditRevision, registrations, releases, readers: owners.size, tabs: tabs.snapshot(scope).tabs.length, selected: tabs.snapshot(scope).selectedID, main: main.draft(), raw }))); }
    if (action === 'edit-50') { for (let i = 0; i < 50; i++) main.setDraftText(`Workbench writer ${i}`); }
  });
  cleanup(controls);
  return <View class="flex-1">
    <Text>workbench-ready</Text><Text>{`workbench-result:${result()}`}</Text><Text>{`file-result:${files()}`}</Text><Text>{`diff-result:${diff()}`}</Text><Text>{`workbench-audit:${counts()}`}</Text>
    <Input testID="workbench-main-input" value={main.draft()} onChange={event => main.setDraftText(event.value)} />
    <Button testID="workbench-child" onPress={() => { void owner()?.navigate({ sessionID: 'child', directory: '/other' }).then(value => result.set(value ? 'child' : 'blocked')); }}><Text>Nested session</Text></Button>
    <Button testID="workbench-focus" onPress={() => { void owner()?.focus('old-parent').then(() => result.set('focus')); }}><Text>Locate message</Text></Button>
    <If when={initialized()}><NativeDesktopPanel scope={scope} tabs={tabs} active={active()} current={current} modalOpen={modal()}
      context={() => <Text>Retained context</Text>} panelChat={{ enabled: enabled(),
        stream: host.params.noStream === true ? undefined : { start: input => native('runtime.stream', input), stop: input => native('runtime.stop', input) },
        renderCard: (card, surface) => <Button testID="workbench-card-child" onPress={() => { if (surface.current()) void surface.navigate({ sessionID: 'child', directory: '/other' }); }}><Text>{String(card.title || '')}</Text></Button>,
        onOwner: (context, next) => { if (next) { owners.set(context.tabID, next); registrations++; } else { owners.delete(context.tabID); releases++; } },
        onOpenFile: input => { if (input.current()) files.set(JSON.stringify({ directory: input.target.directory, sessionID: input.target.id, parent: input.scope.sessionID, path: input.path })); },
        onOpenDiff: input => { if (input.current() && input.source.path) { diff.set(JSON.stringify({ parent: input.scope.sessionID, source: input.source })); tabs.open(input.scope, { kind: 'file-diff', source: { ...input.source, path: input.source.path } }); } },
      }} /></If>
  </View>;
}
function Fixture() { const ready = signal(false); void loadConnections().then(() => ready.set(true)); return <View class="flex-1"><If when={ready()}><Workbench /></If></View>; }
mount(Fixture);
