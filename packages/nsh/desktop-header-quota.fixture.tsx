import { cleanup, host, lifecycle, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { createDesktopHeaderQuotaFamilies, DesktopChatHeaderQuota } from './desktop-chat-header-quota';
import { HeaderQuotaPanel } from './chat-header-quota-ui';
import { createDesktopChatHeaderOwner } from './desktop-chat-header-owner';
import type { ChatHeaderMetadata } from './chat-header-metadata';
import { bindRequest } from './runtime';
import { language } from './i18n';
import { record } from './model';

function Fixture() {
  language.set('en');
  const scope = signal('A'), interactive = signal(true), current = signal(true), mobile = signal(false), input = signal(''), audit = signal(''), presented = signal(true);
  cleanup(host.on('desktop-header-quota.control', payload => {
    const event = payload as { action: string; value?: string | boolean };
    if (event.action === 'modal') interactive.set(event.value !== true);
    if (event.action === 'current') current.set(event.value === true);
    if (event.action === 'scope') scope.set(String(event.value));
    if (event.action === 'mobile') mobile.set(event.value === true);
    if (event.action === 'presented') presented.set(event.value === true);
    if (event.action === 'language') language.set(event.value as 'en');
  }));
  return <View class="flex-1"><Input testID="header-quota-input" value={input()} onChange={event => input.set(event.value)} /><Text>{'quota-audit:' + audit()}</Text>
    <Each of={[scope()]}>{captured => <QuotaConsumer scope={captured()} current={() => current() && scope() === captured()} interactive={interactive() && lifecycle() === 'active'} presented={presented()} mobile={mobile()} audit={value => audit.set(value)} />}</Each>
  </View>;
}
function QuotaConsumer(props: { scope: string; current: () => boolean; interactive: boolean; presented: boolean; mobile: boolean; audit: (value: string) => void }) {
  const captured = props.scope, metadata = signal<ChatHeaderMetadata>({ loading: false, errors: [] });
  const familyState = createDesktopHeaderQuotaFamilies();
  let enumerations = 0, commits = 0, result = '', auditSerial = 0;
  const request = bindRequest({ hostID: 'navigation-root', lease: 'navigation-native-lease' });
  const lane = { current: props.current, request: async (path: string, method?: string) => {
    const payload = await request(path, method), row = record(payload), usage = record(row.usage);
    if (usage.models) usage.models = new Proxy(record(usage.models), { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
    return payload;
  } };
  const owner = createDesktopChatHeaderOwner({ target: { kind: 'assistant', id: 'quota-test', title: '', directory: '/fixture/actual' }, current: props.current, operation: () => lane, changed: value => { commits++; metadata.set(value); } });
  owner.update({ readDemand: true }); cleanup(owner.dispose);
  cleanup(host.on('desktop-header-quota.control', payload => {
    const action = (payload as { action: string }).action;
    if (action === 'audit') props.audit(JSON.stringify({ scope: captured, enumerations, commits, result, serial: ++auditSerial,
      updated: metadata().quota?.lastUpdated, predictions: metadata().quota?.showPredValues, groups: metadata().quota?.groups.map(group => ({ id: group.id, stale: group.stale, keys: group.rows.map(row => row.key) })) }));
    if (action === 'refresh') { void owner.refreshQuotas(true).then(value => { result = value.status; }); }
    if (action === 'revoke') owner.setDemand(false);
  }));
  return <View class="flex-1">
    <If when={props.presented}><DesktopChatHeaderQuota snapshot={metadata().quota} familyState={familyState} interactive={props.interactive} current={props.current} refreshAvailable={props.interactive && props.current()} modeAvailable={false}
      refresh={() => { void owner.refreshQuotas(true).then(value => { result = value.status; }); }} mode={() => { result = owner.setQuotaMode('remaining').status; }} /></If>
    <If when={props.mobile}><HeaderQuotaPanel snapshot={metadata().quota} onRefresh={() => {}} /></If>
  </View>;
}
mount(Fixture);
