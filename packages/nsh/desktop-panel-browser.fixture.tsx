import { cleanup, computed, host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from './desktop-panel';
import type { DesktopPanelScope } from './desktop-panel-model';
import { createDesktopPanelTabsPersistence } from './desktop-panel-tabs-persistence';
import { language } from './i18n';
import { app } from './state';

/** Synthetic production NativeDesktopPanel fixture, not application wiring.
 * No pane/intent forwarding replacement, native page loader or Host writes. */
function Fixture() {
  language.set('en');
  const initial: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'lease-a' }, authorityKey: 'authority-a', sessionID: 'session-a', directory: '/workspace' };
  const scope = signal(initial), covered = signal(false), draft = signal(''), audit = signal(''), ready = signal(false), present = signal(false), controlTicket = signal(0);
  app.runtimeScope.set(initial.host);
  const tabs = createNativeDesktopPanelTabs({ storage: false });
  const ownModal = {};
  let stored: string | null = null, reads = 0, writes = 0, notifications = 0;
  const unsubscribe = tabs.subscribe(() => { notifications++; });
  const metadata = createDesktopPanelTabsPersistence(tabs, { getItem: async () => { reads++; return stored; }, setItem: async (_key, value) => { writes++; stored = value; }, removeItem: async () => { stored = null; } });
  void metadata.restore().then(() => { ready.set(true); });
  cleanup(() => { unsubscribe(); metadata.dispose(); });
  const snapshot = computed(() => tabs.snapshot(scope()));
  const show = () => { tabs.setRail(scope(), null); present.set(true); };
  const off = host.on<{ action: string; url?: string; ticket?: number }>('browser.test.control', event => {
    if (event.action === 'header') { tabs.open(scope(), { kind: 'browser', url: '' }); show(); }
    if (event.action === 'url') { tabs.open(scope(), { kind: 'browser', url: event.url ?? '' }); show(); }
    if (event.action === 'context') tabs.open(scope(), { kind: 'context' });
    if (event.action === 'preview') tabs.open(scope(), { kind: 'preview', path: '/workspace/index.html' });
    if (event.action === 'cover') covered.set(!covered());
    if (event.action === 'internal-modal') tabs.setModal(ownModal, !tabs.modalOpen());
    if (event.action === 'lease') { const next = { ...scope(), host: { ...scope().host, lease: scope().host.lease + '-renewed' } }; scope.set(next); app.runtimeScope.set(next.host); }
    if (event.action === 'host') { present.set(false); const next = scope().host.hostID === initial.host.hostID ? { ...initial, host: { hostID: 'other', lease: 'lease-b' }, authorityKey: 'authority-b' } : initial; scope.set(next); app.runtimeScope.set(next.host); }
    if (event.action === 'close') { const id = snapshot().selectedID; if (id) void tabs.requestClose(scope(), id); }
    if (event.action === 'audit') audit.set(JSON.stringify({ snapshot: snapshot(), metadata: tabs.metadata(), stored: stored ? JSON.parse(stored) : null, reads, writes, notifications, error: tabs.error() }));
    if (event.ticket !== undefined) controlTicket.set(event.ticket);
  });
  cleanup(off);
  return <View class="flex-1">
    <Input testID="browser-fixture-main-input" value={draft()} onChange={event => draft.set(event.value)} />
    <Text>{'browser-fixture-ready:' + ready()}</Text>
    <Text>{'browser-fixture-control:' + controlTicket()}</Text>
    <Text testID="browser-fixture-audit">{audit()}</Text>
    <If when={ready() && present()}><NativeDesktopPanel tabs={tabs} scope={scope()} current={() => true} active modalOpen={covered()} context={() => <View class="flex-1"><Text>Real panel context slot</Text></View>} /></If>
  </View>;
}
mount(Fixture);
