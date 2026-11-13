import { cleanup, effect, mount, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import type { NativeNewSessionPageHandoff } from './new-session';
import { createNewSessionAdmission } from './new-session-admission';
import { NativeNewSessionPage } from './new-session-page';
import { createPageOperations } from './page-operations';
import { request } from './runtime';
import { app, createChat, loadConnections } from './state';
import { loadNativeDesktopWriterClient, type DesktopWriterClient } from './desktop-writer';

function AdmittedChat(props: { handoff: NativeNewSessionPageHandoff }) {
  const writer = props.handoff.desktopWriter;
  const chat = createChat(props.handoff.receipt.target, { draftAuthorityKey: props.handoff.receipt.draftAuthorityKey, ...(writer ? { writerGrant: writer.grant, writerUnknown: writer.markUnknown } : {}) }), status = signal('waiting');
  const operations = createPageOperations(() => chat.active());
  const admission = createNewSessionAdmission({ chat, handoff: props.handoff, current: () => operations.displayCurrent() && chat.active(), operation: operations.operation,
    changed: value => status.set(value) });
  let attempted = false;
  effect(() => { chat.active.set(true); });
  effect(() => {
    const operation = operations.operation();
    if (operation) untracked(() => { if (!attempted) { attempted = true; void admission.run(); } });
  });
  cleanup(() => { void admission.close().catch(() => {}); });
  return <View class="flex-1"><Text testID="desktop-new-session-result">{status()}</Text><Text testID="desktop-new-session-directory">{props.handoff.receipt.target.directory}</Text></View>;
}

function Fixture() {
  language.set('en');
  const ready = signal(false), handoff = signal<NativeNewSessionPageHandoff | null>(null), audit = signal('');
  const client = signal<DesktopWriterClient | undefined>(undefined);
  let alive = true;
  cleanup(() => { alive = false; });
  const project = { id: 'fixture-project', name: 'Native draft project', path: '/fixture/project' };
  void loadConnections().then(async () => {
    const writer = await loadNativeDesktopWriterClient({ current: () => alive });
    if (!alive) return;
    client.set(writer); app.projects.set([project]); ready.set(true);
  });
  return <View class="flex-1 bg-background"><If when={ready()}><If when={!!handoff()} else={<NativeNewSessionPage project={project} desktopWriter={client} active onOpenChat={(_target, value) => handoff.set(value)} />}><AdmittedChat handoff={handoff()!} /></If></If>
    <Button testID="desktop-new-session-audit" onPress={() => { void request('/__fixture/new-session/stats').then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect fixture Host</Text></Button><Text testID="desktop-new-session-audit-result">{audit()}</Text>
  </View>;
}
mount(Fixture);
