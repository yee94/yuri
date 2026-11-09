import { cleanup, host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { NativeDesktopChatHeaderActions } from './desktop-chat-header';
import type { ChatHeaderMetadata } from './chat-header-metadata';
import type { DesktopChatHeaderAction, DesktopChatHeaderActions } from './desktop-chat-header-core';
import { language } from './i18n';
import type { DesktopHeaderGitHubPort } from './desktop-header-github-core';

const active = signal(true), authority = signal(true), scope = signal('A'), operation = signal(true);
const servicesBusy = signal(false);
const draft = signal('Keep draft'), title = signal('Actual session'), contextOpen = signal(false), panelOpen = signal(false), hostLabel = signal('Synthetic Host');
const metadata = signal<ChatHeaderMetadata>({ loading: false, errors: [], tokens: 40_000, limit: 100_000, quota: { loading: false, loaded: true, groups: [], errors: [], displayMode: 'usage', timeFormat: '24h' } });
const available = signal(true), deferred = signal(false), result = signal<'accepted' | 'unsupported' | 'unknown' | 'failed'>('accepted');
const audit = (event: string, extra: Record<string, unknown> = {}) => host.post('desktop.chat.header.test', { event, ...extra });
let release: (() => void) | undefined;
const actions: DesktopChatHeaderActions = Object.fromEntries((['mini-chat', 'terminal', 'browser', 'context', 'work-status', 'toggle-panel', 'open-app', 'copy-path', 'select-app', 'scan-apps', 'github-account', 'refresh-usage', 'quota-mode'] satisfies DesktopChatHeaderAction[]).map(action => [action, {
  get available() { return available(); },
  async run(intent) {
    audit('action-start', { action, value: intent.value });
    if (deferred()) await new Promise<void>(resolve => { release = resolve; });
    if (!intent.current()) { audit('action-rejected', { action }); return { status: 'unsupported' }; }
    audit('action-commit', { action, value: intent.value });
    if (result() === 'accepted') {
      if (action === 'context') contextOpen.set(!contextOpen());
      if (action === 'toggle-panel') panelOpen.set(!panelOpen());
    }
    return { status: result() };
  },
}]));
const lane = { current: () => operation() };
const github: DesktopHeaderGitHubPort = {
  state: () => ({ projection: { login: 'fixture', accounts: [
    { key: JSON.stringify(['oauth', 'a']), id: 'a', source: 'oauth', label: 'Fixture A', login: 'a', current: true },
    { key: JSON.stringify(['oauth', 'b']), id: 'b', source: 'oauth', label: 'Fixture B', login: 'b', current: false },
  ] }, reading: false, busy: false, stale: false, issue: null, pending: null }),
  visible: authority, interactive: () => authority() && active() && operation(),
  available: () => authority() && active() && operation() && available(),
  ensure: async () => ({ status: 'accepted' }), refresh: async () => ({ status: 'accepted' }),
  select: async key => { if (!github.available()) return { status: 'unavailable' }; audit('action-commit', { action: 'github-account', value: key }); return { status: 'accepted' }; },
};
host.on<Record<string, unknown>>('desktop.chat.header.control', event => {
  switch (event.action) {
    case 'active': active.set(event.value === true); break;
    case 'services-busy': servicesBusy.set(event.value === true); break;
    case 'current': authority.set(event.value === true); break;
    case 'scope': scope.set(String(event.value)); break;
    case 'operation': operation.set(event.value === true); break;
    case 'available': available.set(event.value === true); break;
    case 'deferred': deferred.set(event.value === true); break;
    case 'release': release?.(); release = undefined; break;
    case 'result': result.set(event.value as ReturnType<typeof result>); break;
    case 'metadata': metadata.set(event.value as ChatHeaderMetadata); break;
    case 'title': title.set(String(event.value)); break;
    case 'host': hostLabel.set(String(event.value)); break;
    case 'language': language.set(String(event.value)); break;
    default: throw new Error('Unknown header fixture control');
  }
});
function Header() {
  audit('mount'); cleanup(() => audit('unmount'));
  return <NativeDesktopChatHeaderActions scope={scope()} current={authority} active={active()} operation={() => operation() ? lane : null}
    sessionTitle={title()} metadata={metadata()} actions={actions} host={{ label: hostLabel(), icon: 'stack' }}
    openInApps={{ applicable: true, selectedID: 'editor', apps: [{ id: 'editor', label: 'Fixture Editor' }, { id: 'finder', label: 'Fixture Files' }], stale: true }}
    githubPort={github}
    status={{ workStatusSelected: false, panelOpen: panelOpen(), contextOpen: contextOpen(), browserOpen: false }}
    services={{ mcp: () => <Text testID="fixture-mcp">MCP snapshot</Text> }}
    servicesBusy={servicesBusy()} onServicesTabChange={tab => audit('services-tab', { tab })}
    onResult={(action, value) => audit('result', { action, status: value.status })} />;
}
language.set('en');
mount(() => <View class="flex-1"><View style={{ height: 48, alignItems: 'flex-end' }}><Header /></View><Input testID="header-fixture-composer" value={draft()} onChange={event => draft.set(event.value)} /><Text testID="header-fixture-draft">{draft()}</Text></View>);
