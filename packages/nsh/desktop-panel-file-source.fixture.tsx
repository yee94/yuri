import { cleanup, host, mount, signal, Text, View } from 'nsh';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from './desktop-panel';
import { createNativeDesktopPanelTabsPersistence } from './desktop-panel-tabs-native';
import { app } from './state';
import { desktopPanelFileScope, type DesktopPanelScope } from './desktop-panel-model';
import { language } from './i18n';

/** Synthetic Host only; production panel/editor/native-journal adapter are unchanged. */
function Fixture() {
  language.set('en');
  const scope: DesktopPanelScope = { host: { hostID: 'A', lease: 'lease-A' }, authorityKey: 'authority-A', directory: '/parent', sessionID: 'parent' };
  app.runtimeScope.set(scope.host);
  const tabs = createNativeDesktopPanelTabs(), metadata = createNativeDesktopPanelTabsPersistence(tabs);
  const ready = signal(false), active = signal(true), modal = signal(false), result = signal(''), audit = signal('');
  const source = { directory: '/other', sessionID: 'child' };
  const current = () => app.runtimeScope()?.hostID === scope.host.hostID && app.runtimeScope()?.lease === scope.host.lease;
  let serial = 0;
  void metadata.ready.then(() => {
    if (!tabs.snapshot(scope).tabs.length) tabs.open(scope, { kind: 'context' });
    ready.set(true);
  });
  cleanup(host.on('file-source.control', payload => {
    const input = payload as { action: string; path?: string; line?: number };
    void (async () => {
      if (input.action === 'open' && current() && active() && !modal()) {
        const id = tabs.openFileReference(scope, source, input.path ?? 'a.ts', input.line);
        if (id) tabs.setRail(scope, null);
        result.set('open:' + id);
      }
      if (input.action === 'tree') { tabs.setRail(scope, 'files'); tabs.open(scope, { kind: 'file', path: '/parent/tree.ts' }); }
      if (input.action === 'cover') modal.set(true);
      if (input.action === 'uncover') modal.set(false);
      if (input.action === 'hide') active.set(false);
      if (input.action === 'show') active.set(true);
      if (input.action === 'retire') app.runtimeScope.set({ hostID: 'B', lease: 'lease-B' });
      if (input.action === 'save') {
        result.set('pending:save');
        const tab = tabs.snapshot(scope).tabs.find(tab => tab.id === tabs.snapshot(scope).selectedID);
        const doc = tab?.kind === 'file' ? tabs.editors.model.peek(desktopPanelFileScope(scope, tab), tab.path) : undefined;
        result.set('save:' + (doc ? await tabs.editors.save(doc) : false));
      }
      if (input.action === 'close') { result.set('pending:close'); result.set('close:' + await tabs.requestClose(scope, tabs.snapshot(scope).selectedID!)); }
      if (input.action === 'window') result.set('window:' + await tabs.requestWindowClose());
      if (input.action === 'flush') result.set('flush:' + await tabs.editors.journal!.flush() + ':' + await metadata.flush());
      if (input.action === 'audit') audit.set(JSON.stringify({ serial: ++serial, snapshot: tabs.snapshot(scope), journal: tabs.journalState(),
        docs: tabs.editors.model.documents().map(doc => ({ scope: doc.storedScope, path: doc.path, state: doc.state() })) }));
    })();
  }));
  return <View class="flex-1"><Text testID="source-parent-content">Retained main content</Text><Text>{'source-result:' + result()}</Text><Text>{'source-audit:' + audit()}</Text>
    <If when={ready()}><NativeDesktopPanel scope={scope} tabs={tabs} active={active()} current={current} modalOpen={modal()} context={() => <Text>Source context</Text>} /></If>
  </View>;
}
mount(Fixture);
