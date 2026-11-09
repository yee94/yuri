import { cleanup, effect, host, mount, signal, Text, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { app, createChat, loadConnections } from './state';
import { desktopGitDraftAuthority } from './desktop-git-dispatch';
import { DesktopPanelChat, type DesktopPanelChatHandle } from './desktop-panel-chat';
import { native } from './runtime';
import type { DesktopPanelChatStream } from './desktop-panel-chat-source';

function Owners() {
  const main = createChat({ kind: 'session', id: 's', directory: '/repo', title: 'Main' });
  const open = signal(true), active = signal(true), interactive = signal(true), mainActive = signal(true), audit = signal(''), result = signal('');
  const panelTarget = host.params.standalone === true ? 'other' : 's';
  const port: DesktopPanelChatStream = { start: input => native('runtime.stream', input), stop: input => native('runtime.stop', input) };
  const stream = signal<DesktopPanelChatStream | undefined>(host.params.noStream === true ? undefined : port);
  const authority = { hostID: app.connection()!.id, authorityKey: desktopGitDraftAuthority(app.connection()!) };
  let owner: DesktopPanelChatHandle | null = null, mounts = 0, disposals = 0, work = 0;
  let instrumented = false;
  effect(() => { const value = mainActive(); untracked(() => main.active.set(value)); });
  function instrument() {
    const rows = main.messages();
    main.messages.set(new Proxy(rows, { get: (target, key, receiver) => { if (instrumented) work++; return Reflect.get(target, key, receiver); } }));
  }
  const control = host.on('panel.test.control', payload => {
    const action = (payload as { action: string }).action;
    if (action === 'hide') active.set(false);
    if (action === 'show') active.set(true);
    if (action === 'cover') interactive.set(false);
    if (action === 'uncover') interactive.set(true);
    if (action === 'close') open.set(false);
    if (action === 'grant-stream') stream.set(port);
    if (action === 'main-off') mainActive.set(false);
    if (action === 'main-on') mainActive.set(true);
    if (action === 'arm-work') { instrumented = false; instrument(); }
    if (action === 'reset-work') { work = 0; instrumented = true; }
    if (action === 'edit-50') { for (let i = 0; i < 50; i++) main.setDraftText(`Main private draft ${i}`); }
    if (action === 'host') { const connection = app.connection()!; app.connection.set({ ...connection, authorizationID: 'other-auth' }); }
    if (action === 'lease') void loadConnections({ forceReconnect: true }).then(() => result.set('lease-done'));
  });
  cleanup(control);
  async function report() { audit.set(JSON.stringify({ mounts, disposals, work, mainDraft: main.draft(), mainBusy: main.busy() })); }
  return <View class="flex-1">
    <Text>fixture-ready</Text><Text>{`result:${result()}`}</Text><Text>{`main-busy:${main.busy()}`}</Text><Text testID="panel-audit">{audit()}</Text>
    <Input testID="main-input" value={main.draft()} onChange={event => main.setDraftText(event.value)} />
    <Button testID="panel-audit-button" onPress={() => { void report(); }}><Text>Audit</Text></Button>
    <Button testID="panel-focus-old" onPress={() => { void owner?.focus('old').then(() => result.set('focus-done')); }}><Text>Focus older</Text></Button>
    <Button testID="panel-focus-missing" onPress={() => { void owner?.focus('missing').then(() => result.set('missing-done')); }}><Text>Focus missing</Text></Button>
    <Button testID="panel-child" onPress={() => { void owner?.navigate({ sessionID: 'child', directory: '/repo' }).then(value => result.set(value ? 'child-open' : 'child-blocked')); }}><Text>Child</Text></Button>
    <Button testID="panel-wrong-dir" onPress={() => { void owner?.navigate({ sessionID: 'child', directory: '/wrong' }).then(value => result.set(value ? 'wrong-open' : 'wrong-blocked')); }}><Text>Wrong directory</Text></Button>
    <Button testID="panel-retry-handle" onPress={() => { void owner?.retry().then(() => result.set('retry-done')); }}><Text>Retry</Text></Button>
    <If when={open()}><DesktopPanelChat surfaceID="fixture-panel" target={{ sessionID: panelTarget, directory: '/repo' }} authority={authority}
      active={active()} interactive={interactive()} renderCard={card => <Text>{String(card.title ?? '')}</Text>}
      stream={stream()}
      onOwner={value => { owner = value; if (value) mounts++; else disposals++; }} /></If>
  </View>;
}
function Fixture() {
  const ready = signal(false);
  void loadConnections().then(() => ready.set(true));
  return <View class="flex-1"><If when={ready()}><Owners /></If></View>;
}
mount(Fixture);
