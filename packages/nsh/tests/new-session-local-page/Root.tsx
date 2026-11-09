import { cleanup, effect, mount, signal, Text, untracked, View } from 'nsh';
import { NativeNewSessionPage } from '../../new-session-page';
import { createNewSessionAdmission } from '../../new-session-admission';
import type { NativeNewSessionPageHandoff } from '../../new-session';
import { createPageOperations } from '../../page-operations';
import { app, createChat, loadConnections } from '../../state';
import { language } from '../../i18n';
import { loadNativeDesktopWriterClient } from '../../desktop-writer';
import type { DesktopWriterClient } from '../../desktop-writer-core';

function Admitted(props: { handoff: NativeNewSessionPageHandoff }) {
  const writer = props.handoff.desktopWriter;
  const chat = createChat(props.handoff.receipt.target, { draftAuthorityKey: props.handoff.receipt.draftAuthorityKey, ...(writer ? { writerGrant: writer.grant, writerUnknown: writer.markUnknown } : {}) });
  const operations = createPageOperations(() => chat.active()), status = signal('waiting');
  const admission = createNewSessionAdmission({ chat, handoff: props.handoff, current: () => operations.displayCurrent() && chat.active(), operation: operations.operation, changed: value => status.set(value) });
  let started = false;
  effect(() => { const operation = operations.operation(); if (operation) untracked(() => { if (!started) { started = true; void admission.run(); } }); });
  cleanup(() => { void admission.close().catch(() => {}); });
  return <View><Text testID="local-page-admission">{status()}</Text><Text testID="local-page-source">{props.handoff.owner.durable.draft()}</Text></View>;
}
function Fixture() {
  language.set('en');
  const ready = signal(false), handoff = signal<NativeNewSessionPageHandoff | null>(null);
  const writer = signal<DesktopWriterClient | undefined>(undefined);
  let alive = true;
  cleanup(() => { alive = false; });
  const project = { id: 'fixture-project', name: 'Local command project', path: '/fixture/project' };
  void loadConnections().then(async () => { writer.set(await loadNativeDesktopWriterClient({ current: () => alive })); app.projects.set([project]); ready.set(true); });
  return <View class="flex-1"><If when={ready()}><If when={!!handoff()} else={<NativeNewSessionPage project={project} desktopWriter={writer} active onOpenChat={(_target, value) => handoff.set(value)} />}><Admitted handoff={handoff()!} /></If></If></View>;
}
mount(Fixture);
