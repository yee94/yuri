import { cleanup, effect, mount, platform, signal, Text, untracked, View } from 'nsh';
import { Button, createNavStack, NavStack } from 'nsh/base';
import { desktopGitContextInput, desktopGitDraftAuthority, type DesktopGitContextInput, type DesktopGitStageConfirmation } from './desktop-git-dispatch';
import type { DesktopGitOwnerPublisher } from './desktop-git-dispatch-owner';
import { openDraft } from './drafts';
import { language } from './i18n';
import { createNewSessionAdmission } from './new-session-admission';
import type { NativeNewSessionOwner, NativeNewSessionPageHandoff } from './new-session';
import { NativeNewSessionPage } from './new-session-page';
import { createPageOperations } from './page-operations';
import { request } from './runtime';
import { app, createChat, loadConnections } from './state';

const project = { id: 'fixture-project', name: 'Native draft project', path: '/fixture/project' };

function AdmittedChat(props: { handoff: NativeNewSessionPageHandoff }) {
  const chat = createChat(props.handoff.receipt.target, { draftAuthorityKey: props.handoff.receipt.draftAuthorityKey });
  const operations = createPageOperations(() => chat.active()), state = signal('waiting');
  const admission = createNewSessionAdmission({ chat, handoff: props.handoff, current: () => operations.displayCurrent() && chat.active(), operation: operations.operation, changed: value => state.set(value) });
  let attempted = false;
  effect(() => { const operation = operations.operation(); if (operation) untracked(() => { if (!attempted) { attempted = true; void admission.run(); } }); });
  cleanup(() => { void admission.close().catch(() => {}); });
  return <View><Text testID="git-owner-admission">{state()}</Text><Text testID="git-owner-handoff-key">{props.handoff.receipt.draftAuthorityKey ?? 'legacy'}</Text></View>;
}

function Fixture() {
  language.set('en');
  const ready = signal(false), active = signal(true), handoff = signal<NativeNewSessionPageHandoff | null>(null);
  const initial = signal<DesktopGitContextInput | undefined>(undefined), ownerStatus = signal('none'), stageStatus = signal('idle'), audit = signal(''), intents = signal(0);
  const navigation = createNavStack([{ kind: 'new' }]);
  let owner: NativeNewSessionOwner | undefined, confirmation: DesktopGitStageConfirmation | undefined;
  const publish: DesktopGitOwnerPublisher = event => {
    if (event.type === 'register' && event.owner.current()) { owner = event.owner; ownerStatus.set(`active:${owner.directory}`); }
    else if (event.type === 'retire' && owner === event.owner) { owner = undefined; ownerStatus.set('none'); }
  };
  async function stage(confirm = false) {
    const input = initial(), captured = owner;
    if (!input || !captured?.current()) return;
    const result = await captured.stageContext(input, confirm ? confirmation : undefined);
    stageStatus.set(result.status);
    if (result.status === 'requires-confirmation') confirmation = result.confirmation;
  }
  void loadConnections().then(async () => {
    const connection = app.connection()!, scope = app.runtimeScope()!, key = platform?.desktop ? desktopGitDraftAuthority(connection) : undefined;
    const prior = openDraft(connection.id, { kind: 'session', id: 'new-session-draft', directory: project.path, title: '' }, key);
    await prior.ready; prior.setDraftText('Existing local draft'); await prior.close();
    initial.set(desktopGitContextInput({ scope: { host: scope, authorityKey: desktopGitDraftAuthority(connection), directory: project.path, sessionID: null }, directory: project.path, target: 'new', kind: 'conflict', visibleText: 'Captured visible request', instructionsText: 'Captured hidden instructions', payload: { diff: 'Captured diff' } }));
    app.projects.set([project]); ready.set(true);
  });
  function ActivePage() { return <NativeNewSessionPage project={project} active={active()} initialContext={initial()} onDesktopOwner={publish} onUserIntent={() => intents.set(intents() + 1)} onOpenChat={(_target, value) => handoff.set(value)} />; }
  return <View class="flex-1 bg-background"><If when={ready()}><If when={!!handoff()} else={<>
    <If when={platform?.desktop} else={<NavStack state={navigation}>{() => <ActivePage />}</NavStack>}><ActivePage /><NativeNewSessionPage directory={project.path} active={false} onDesktopOwner={publish} onOpenChat={() => { throw new Error('Inactive page sent'); }} /></If>
  </>}><AdmittedChat handoff={handoff()!} /></If></If>
    <View class="gap-2"><Text testID="git-owner-status">{ownerStatus()}</Text><Text testID="git-owner-stage-status">{stageStatus()}</Text><Text testID="git-owner-user-intents">{`intents:${intents()}`}</Text>
      <Button testID="git-owner-stage" onPress={() => { void stage(); }}><Text>Stage captured request</Text></Button>
      <Button testID="git-owner-confirm" onPress={() => { void stage(true); }}><Text>Confirm captured replacement</Text></Button>
      <Button testID="git-owner-toggle" onPress={() => active.set(!active())}><Text>Toggle active page</Text></Button>
      <Button testID="git-owner-audit" onPress={() => { void request('/__fixture/new-session/stats').then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect isolated Host</Text></Button><Text testID="git-owner-audit-result">{audit()}</Text>
    </View>
  </View>;
}
mount(Fixture);
