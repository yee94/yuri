import { cleanup, host, lifecycle, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { createNativeDesktopHeaderGitHubSource } from './desktop-header-github';
import { DesktopHeaderGitHub } from './desktop-header-github-view';
import { createSettingsGitHub } from './settings-github-core';
import { bindRequest } from './runtime';
import { language } from './i18n';

function Fixture() {
  language.set('en');
  const scope = signal('A'), active = signal(true), interactive = signal(true), current = signal(true), shown = signal(true), input = signal(''), audit = signal('');
  cleanup(host.on('desktop-header-github.control', payload => {
    const event = payload as { action: string; value?: boolean | string };
    if (event.action === 'active') active.set(event.value === true);
    if (event.action === 'modal') interactive.set(event.value !== true);
    if (event.action === 'authority') current.set(event.value === true);
    if (event.action === 'scope') scope.set(String(event.value));
    if (event.action === 'shown') shown.set(event.value === true);
  }));
  return <View class="flex-1 p-4 gap-2"><Input testID="github-header-input" value={input()} onChange={event => input.set(event.value)} /><Text>{'github-audit:' + audit()}</Text>
    <Each of={[scope()]} key={value => value}>{captured => <Header scope={captured()} current={() => current() && scope() === captured()} active={active() && lifecycle() === 'active'} interactive={interactive() && lifecycle() === 'active'} shown={shown()} audit={value => audit.set(value)} />}</Each>
  </View>;
}
function Header(props: { scope: string; current: () => boolean; active: boolean; interactive: boolean; shown: boolean; audit: (value: string) => void }) {
  const captured = props.scope, hostScope = { hostID: 'github-' + captured, lease: 'lease-' + captured };
  const send = bindRequest(hostScope), lane = { scope: hostScope, current: props.current, request: send };
  let commits = 0, serial = 0, result = '', mounts = 0, enumerations = 0, opens = 0, revokeOnOpen = false;
  const otherPopup = signal(false), presentationPermission = signal(true);
  const source = createNativeDesktopHeaderGitHubSource({ scope: { host: hostScope, authorityKey: 'authority-' + captured, directory: '/fixture/' + captured }, current: props.current, operation: () => lane, changed: () => { commits++; } });
  const guard = { current: props.current, active: () => props.active, interactive: () => props.interactive && presentationPermission(), directory: () => '/fixture/' + captured };
  const port = source.header(guard);
  const observed = { ...port, state() { const state = port.state(); if (state.projection) enumerations++; return state; } };
  let registration: ReturnType<typeof source.settings> | undefined, controller: ReturnType<typeof createSettingsGitHub> | undefined;
  cleanup(() => { controller?.dispose(); registration?.dispose(); source.retire(); source.dispose(); });
  cleanup(host.on('desktop-header-github.control', payload => {
    const { action, value } = payload as { action: string; value?: boolean };
    if (action === 'other-popup') otherPopup.set(value === true);
    if (action === 'revoke-on-open') revokeOnOpen = value === true;
    if (action === 'presentation') presentationPermission.set(value === true);
    if (action === 'ensure') { void port.ensure().then(value => { result = value.status; }); }
    if (action === 'refresh') { void port.refresh().then(value => { result = value.status; }); }
    if (action === 'settings') {
      registration = source.settings(guard, async () => false); controller = createSettingsGitHub(registration.dependencies);
      void controller.setActive(true);
    }
    if (action === 'settings-select') { const account = controller?.state().status?.accounts.find(account => account.id === 'b'); if (account) void controller?.activate(account); }
    if (action === 'audit') props.audit(JSON.stringify({ serial: ++serial, scope: captured, commits, mounts, enumerations, result, opens,
      login: source.state().projection?.login, reading: source.state().reading, issue: source.state().issue, pending: !!source.state().pending, available: port.available(), settingsLogin: controller?.state().status?.user?.login }));
  }));
  if (host.params.auto !== false) void port.ensure();
  function Production() { mounts++; return <DesktopHeaderGitHub port={observed} onOpen={() => { opens++; otherPopup.set(false); if (revokeOnOpen) presentationPermission.set(false); }} onResult={value => { result = value.status; }} />; }
  return <View><If when={otherPopup()}><View testID="github-other-popup"><Text>Other popup</Text></View></If><If when={props.shown}><Production /></If></View>;
}
mount(Fixture);
