import { cleanup, effect, host, mount, signal, Text, untracked, View } from 'nsh';
import { Input } from 'nsh/base';
import { captureHostOperation, createChat, loadConnections, observeRuntime } from '../../state';
import { observeDesktopWorkStatusChildren, readDesktopWorkStatusChildren } from '../../desktop-work-status-source';
import { desktopWorkStatusAgents } from '../../desktop-work-status-core';

const target = { kind: 'session' as const, id: 'parent', directory: '/fixture/project', title: 'Synthetic Chat' };
const audit = (event: string, value?: unknown) => host.post('work.status.source.audit', { event, value });
// Delay only an already-returned public native response, not the nsh/test handler
// itself (which would block its driver). No source/controller/route is injected.
const call = host.call.bind(host), held: Array<() => void> = [];
let hold = (host.params as Record<string, unknown>).holdStatus === true;
host.call = async function <T>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T> {
  const value = await call<T>(name, data, options);
  if (hold && name === 'runtime.request' && (data as { path?: string })?.path === '/api/session/active') {
    hold = false; audit('held'); await new Promise<void>(resolve => held.push(resolve)); audit('released');
  }
  return value;
};

function ChatSource() {
  const chat = createChat(target);
  let stopChildren = () => {};
  if ((host.params as Record<string, unknown>).children === true) {
    const operation = captureHostOperation(), scope = { host: operation.scope!, authorityKey: 'fixture-authority', sessionID: target.id, directory: target.directory };
    void readDesktopWorkStatusChildren(operation, scope).then(children => { stopChildren = observeDesktopWorkStatusChildren(operation, scope, children, rows => audit('children', { rows, agents: desktopWorkStatusAgents(chat.workStatus(), rows) })); });
  }
  cleanup(() => stopChildren());
  effect(() => {
    const value = chat.workStatus();
    untracked(() => audit('projection', { activity: value.activity, taskIdentity: value.tasks === chat.tasks(), tasks: value.tasks, faces: value.taskFaces, live: [...value.liveTaskPartIDs], shell: value.backgroundShell }));
  });
  return <View class="flex-1 bg-background"><Input testID="source-real-draft" value={chat.draft()} onChange={event => chat.setDraftText(event.value)} /><Text>Original Chat source mounted</Text></View>;
}
function Fixture() {
  const ready = signal(false), owner = signal(0);
  if ((host.params as Record<string, unknown>).children === true) observeRuntime(() => {});
  void loadConnections().then(() => ready.set(true));
  const stop = host.on<{ action: string }>('work.status.source.control', event => {
    if (event.action === 'release') held.splice(0).forEach(resolve => resolve());
    else if (event.action === 'replace') void loadConnections({ forceReconnect: true }).then(() => owner.set(owner() + 1));
    else throw new Error('Unknown original Chat source control');
  });
  cleanup(stop);
  return <If when={ready()}><Each of={[owner()]} key={value => value}>{() => <ChatSource />}</Each></If>;
}
mount(Fixture);
