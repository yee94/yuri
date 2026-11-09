import { cleanup, host, mount, safeArea, signal, Scroll, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { attachmentFrom } from '../../attachments';
import type { ContactAttachment } from '../../model';
import { ContactAttachmentPreview } from '../../resources';
import { createResourceRouteExit } from '../../resource-retirement';
import { native } from '../../runtime';
import type { RuntimeScope } from '../../runtime-scope';
import { app } from '../../state';
import { language } from '../../i18n';

if (host.params.contactResourceSyntheticOnly !== true) throw Error('Independent synthetic fixture required');
language.set('en');
type Route = { kind: 'root' } | { kind: 'contact'; file: ContactAttachment; expectedHost: RuntimeScope };
const nav = createNavStack<Route>([{ kind: 'root' }]), audit = signal(''), failed = signal(false);
const action = 'flex-1 min-w-0 h-11 min-h-11 items-center justify-center px-2 rounded-xl bg-secondary';
function ContactPage(props: { route: Extract<Route, { kind: 'contact' }> }) {
  const state = signal({ pending: false, error: '' });
  const exit = createResourceRouteExit({ current: () => nav.routes().at(-1) === props.route, pop: () => nav.pop(), changed: value => state.set(value) });
  const back = () => { void exit.back().catch(() => {}); };
  const body = <ContactAttachmentPreview file={props.route.file} expectedHost={props.route.expectedHost} active={nav.routes().at(-1) === props.route} retirementOwner={owner => exit.attach(owner)} onClose={back} />;
  cleanup(exit.detachDisplay);
  return <NavPage title={props.route.file.name} class="flex-1 bg-background" popOnBack={false} popOnSwipe={false} onBackPress={back}>
    {body}<If when={!!state().error}><Button class={action} testID="contact-resource-retire-retry" disabled={state().pending} onPress={back}><Text>Retry original retirement</Text></Button></If>
  </NavPage>;
}
function Fixture() {
  const inspect = () => { void native('fixture.contactResource.audit').then(value => audit.set(JSON.stringify(value))).catch(() => failed.set(true)); };
  const open = (kind: string) => { void native<{ file: unknown; expectedHost: RuntimeScope }>('fixture.contactResource.select', { kind }).then(value => {
    const file = attachmentFrom(value.file, { hostID: value.expectedHost.hostID, target: { kind: 'assistant', id: 'synthetic-contact' } });
    if (file.kind !== 'contact') throw Error('Expected contact descriptor');
    app.connection.set({ id: value.expectedHost.hostID, url: 'https://synthetic.invalid', label: 'Synthetic memory only', lastUsedAt: 0 });
    app.runtimeScope.set(value.expectedHost);
    nav.push({ kind: 'contact', file, expectedHost: value.expectedHost });
  }).catch(() => failed.set(true)); };
  return <View class="flex-1 bg-background" style={{ paddingTop: safeArea().top, paddingBottom: safeArea().bottom, paddingLeft: safeArea().left, paddingRight: safeArea().right }}>
    <View class="shrink-0 gap-2 p-2"><View class="flex-row gap-2"><Button class={action} testID="contact-resource-png" onPress={() => open('png')}><Text>Open synthetic long PNG</Text></Button><Button class={action} testID="contact-resource-pdf" onPress={() => open('pdf')}><Text>Open synthetic PDF</Text></Button></View>
      <View class="flex-row gap-2"><Button class={action} testID="contact-resource-reset" onPress={() => { void native('fixture.contactResource.reset').then(inspect).catch(() => failed.set(true)); }}><Text>Reset contact generation</Text></Button><Button class={action} testID="contact-resource-audit" onPress={inspect}><Text>Read metadata audit</Text></Button></View></View>
    <NavStack state={nav} class="flex-1 min-h-0">{route => route.kind === 'contact' ? <ContactPage route={route} /> : <NavPage title="Synthetic Contact Preview QA" class="flex-1 bg-background"><Scroll class="flex-1" contentClass="p-4 gap-3">
      <Text>Actual ContactAttachmentPreview / ResourceBridge. Memory-only generation 7 descriptors. No picker, network, Host or credentials.</Text>
      <Text testID="contact-resource-audit-value">{audit()}</Text><Text>{String(host.params.buildID)}</Text>
      <If when={failed()}><Text testID="contact-resource-failure">Synthetic fixture operation failed</Text></If>
    </Scroll></NavPage>}</NavStack>
  </View>;
}
mount(Fixture);
