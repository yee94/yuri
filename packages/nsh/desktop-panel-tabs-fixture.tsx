import { cleanup, computed, host, mount, platform, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { createNativeDesktopPanelTabs } from './desktop-panel';
import { DesktopPanelTabs } from './desktop-panel-tabs';
import { Icon } from './Icon';
import type { DesktopPanelScope } from './desktop-panel-model';
import { createNativeDesktopPanelTabsPersistence, DesktopPanelTabsMetadataFeedback } from './desktop-panel-tabs-native';
import { DESKTOP_PANEL_METADATA_KEY } from './desktop-panel-tabs-persistence';
import { createDesktopTabEventGate } from './desktop-panel-tabs-events-core';
import { createDesktopPanelTabsInteraction } from './desktop-panel-tabs-core';

/** Headless-only synthetic fixture. No network, native window, filesystem or Host write.
 * Document journal disabled deliberately; tests exercise actual editor dirty guards,
 * not journal durability. Metadata uses the public NSH Storage adapter. */
function Fixture() {
  language.set('en');
  const session = signal('session-a'), hostID = signal('synthetic'), auth = signal('auth-a'), directory = signal('/workspace'), lease = signal('lease-a');
  const visible = signal(true), active = signal(true), ready = signal(false), width = signal(860), expanded = signal(false);
  const headerSize = signal({ width: 0, height: 0 });
  const menus = signal(false), menuOwned = signal(false);
  const scope = computed<DesktopPanelScope>(() => ({ host: { hostID: hostID(), lease: lease() }, authorityKey: auth(), sessionID: session(), directory: directory() }));
  const tabs = createNativeDesktopPanelTabs({ storage: false });
  const nativeScope = scope(), nativeID = JSON.stringify(['file', '/workspace/b.ts']);
  const nativeCurrent = () => active() && scope().host.lease === nativeScope.host.lease && scope().sessionID === nativeScope.sessionID && scope().directory === nativeScope.directory && scope().authorityKey === nativeScope.authorityKey && scope().host.hostID === nativeScope.host.hostID;
  const nativeInteraction = createDesktopPanelTabsInteraction({ tabs, scope: () => nativeScope, current: nativeCurrent });
  const syntheticGate = createDesktopTabEventGate({
    binding: () => ({ owner: 'synthetic-delivery', generation: 1, revision: 1, expectedHost: nativeScope.host, rect: { x: 0, y: 0, width: 60, height: 24 }, active: visible() }),
    current: () => nativeCurrent() && tabs.snapshot(nativeScope).tabs.some(tab => tab.id === nativeID), enabled: () => active(), modal: tabs.modalOpen, windows: platform.os === 'windows',
    middle: () => nativeInteraction.pointerClose(nativeID, 'middle'), focus: () => {}, blur: () => {},
  });
  // Fixture-only synthetic native delivery. Production has no JS close command.
  const offSynthetic = host.on('synthetic.tab.middleClose', event => { syntheticGate.event('middleClose', event); });
  cleanup(() => { offSynthetic(); syntheticGate.dispose(); nativeInteraction.dispose(); });
  let failWrite = false;
  const persistence = createNativeDesktopPanelTabsPersistence(tabs, { storage: {
    getItem: key => Storage.getItem(key), removeItem: key => Storage.removeItem(key),
    setItem: async (key, value) => { if (failWrite) { failWrite = false; throw new Error('synthetic_metadata_write_failure'); } await Storage.setItem(key, value); },
  } });
  const metadata = persistence.state;
  const documents = new Map<string, ReturnType<typeof tabs.editors.model.acquire>>();
  async function seed() {
    for (const path of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      tabs.open(scope(), { kind: 'file', path });
      const captured = scope(), acquired = tabs.editors.model.acquire(captured, path); if (!acquired) throw new Error('fixture_capacity'); documents.set(path, acquired);
      await tabs.editors.model.load(acquired.document, { scope: captured, current: () => true, request: async route => route.includes('/stat?') ? { path: '/workspace/' + path, isFile: true, isBinary: false, size: 4, mtimeMs: 1, mimeType: 'text/plain' } : 'BASE' });
    }
    ready.set(true);
  }
  void persistence.ready.then(() => { if (!tabs.snapshot(scope()).tabs.length) return seed(); ready.set(true); });
  function dirty(path: string) { const value = documents.get(path); if (value) tabs.editors.model.edit(value.document, 'CHANGED ' + path); }
  return <View class="flex-1 p-2 gap-2">
    <View class="flex-row flex-wrap gap-2">
      <Button testID="tabs-fixture-dirty-b" onPress={() => dirty('b.ts')}><Text>Dirty B</Text></Button>
      <Button testID="tabs-fixture-dirty-c" onPress={() => dirty('c.ts')}><Text>Dirty C</Text></Button>
      <Button testID="tabs-fixture-show" onPress={() => visible.set(true)}><Text>Show</Text></Button>
      <Button testID="tabs-fixture-active" onPress={() => active.set(!active())}><Text>Active</Text></Button>
      <Button testID="tabs-fixture-narrow" onPress={() => width.set(240)}><Text>Narrow</Text></Button>
      <Button testID="tabs-fixture-wide" onPress={() => width.set(860)}><Text>Wide</Text></Button>
      <Button testID="tabs-fixture-panel-width" onPress={() => width.set(412)}><Text>Panel width</Text></Button>
      <Button testID="tabs-fixture-session" onPress={() => session.set(session() === 'session-a' ? 'session-b' : 'session-a')}><Text>Session</Text></Button>
      <Button testID="tabs-fixture-host" onPress={() => hostID.set(hostID() === 'synthetic' ? 'other' : 'synthetic')}><Text>Host</Text></Button>
      <Button testID="tabs-fixture-auth" onPress={() => auth.set(auth() === 'auth-a' ? 'auth-b' : 'auth-a')}><Text>Auth</Text></Button>
      <Button testID="tabs-fixture-directory" onPress={() => directory.set(directory() === '/workspace' ? '/other' : '/workspace')}><Text>Directory</Text></Button>
      <Button testID="tabs-fixture-renew" onPress={() => lease.set(lease() + '-renewed')}><Text>Renew</Text></Button>
      <Button testID="tabs-fixture-add" onPress={() => tabs.open(scope(), { kind: 'context' })}><Text>Context</Text></Button>
      <Button testID="tabs-fixture-chat" onPress={() => tabs.open(scope(), { kind: 'chat', target: { sessionID: 'readonly-session', directory: '/workspace', title: 'Synthetic session' } })}><Text>Chat source</Text></Button>
      <Button testID="tabs-fixture-chat-refresh" onPress={() => tabs.open(scope(), { kind: 'chat', target: { sessionID: 'readonly-session', directory: '/workspace', title: 'Updated session', messageID: 'message-target' } })}><Text>Chat navigation update</Text></Button>
      <Button testID="tabs-fixture-menu" onPress={() => menus.set(!menus())}><Text>Optional close menu</Text></Button>
      <Button testID="tabs-fixture-menu-owned" onPress={() => menuOwned.set(!menuOwned())}><Text>Menu owned strokes</Text></Button>
      <Button testID="tabs-fixture-root-close" onPress={() => { const captured = scope(), id = tabs.snapshot(captured).selectedID; if (id) void tabs.requestClose(captured, id); }}><Text>Root close</Text></Button>
      <Button testID="tabs-fixture-presentations" onPress={() => {
        tabs.open(scope(), { kind: 'context' });
        tabs.open(scope(), { kind: 'browser', url: 'https://example.invalid/' });
        tabs.open(scope(), { kind: 'preview', path: 'index.html' });
        tabs.open(scope(), { kind: 'diff', source: { kind: 'workspace', directory: directory(), staged: true } });
      }}><Text>Presentation sources</Text></Button>
      <Button testID="tabs-fixture-fail-write" onPress={() => { failWrite = true; }}><Text>Fail metadata write</Text></Button>
      <Button testID="tabs-fixture-repair-metadata" onPress={() => { void Storage.setItem(DESKTOP_PANEL_METADATA_KEY, JSON.stringify({ version: 1, scopes: [] })); }}><Text>Repair synthetic metadata</Text></Button>
    </View>
    <Text>{'tabs-ready:' + ready()}</Text>
    <Text>{'tabs-state:' + JSON.stringify({ ids: tabs.snapshot(scope()).tabs.map(tab => tab.id), selected: tabs.snapshot(scope()).selectedID, dirtyB: tabs.isDirty(scope(), 'b.ts'), dirtyC: tabs.isDirty(scope(), 'c.ts'), visible: visible(), expanded: expanded(), modal: tabs.modalOpen() })}</Text>
    <Text>{'tabs-metadata:' + JSON.stringify(metadata())}</Text>
    <Text>{'tabs-layout:' + JSON.stringify(headerSize())}</Text>
    <DesktopPanelTabsMetadataFeedback metadata={persistence} current={() => true} active={active()} />
    <View style={{ width: width() }} onLayout={event => { const next = event.bounds.size; if (next.width !== headerSize().width || next.height !== headerSize().height) headerSize.set(next); }}><If when={visible()}><DesktopPanelTabs tabs={tabs} scope={scope()} current={() => true} active={active()}
      closeLabels={menus() ? { close: 'Close', others: 'Close Others', right: 'Close Right', all: 'Close All' } : undefined}
      menuOwnedKeystrokes={menuOwned() ? [platform.os === 'macos' ? 'CMD+W' : 'CTRL+W', 'shift+alt+left', 'arrowright'] : []}
      railActions={<View class="flex-row" style={{ width: 56, height: 28 }}><Button style={{ width: 28, height: 28 }} onPress={() => tabs.setRail(scope(), 'git')}><Icon name="git-branch" size={14} /></Button><Button style={{ width: 28, height: 28 }} onPress={() => tabs.setRail(scope(), 'files')}><Icon name="list-unordered" size={14} /></Button></View>}
      expanded={expanded()} onToggleExpanded={() => expanded.set(!expanded())} onClose={() => visible.set(false)} /></If></View>
    <Text>{'selected-body:' + (tabs.snapshot(scope()).tabs.find(tab => tab.id === tabs.snapshot(scope()).selectedID)?.kind ?? 'none')}</Text>
  </View>;
}
mount(Fixture);
