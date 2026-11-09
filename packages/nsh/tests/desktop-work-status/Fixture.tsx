import { computed, effect, host, lifecycle, mount, signal, Text, untracked, View, windowSize } from 'nsh';
import { Input } from 'nsh/base';
import { createNativeDesktopWorkStatusOwner, createNativeDesktopWorkStatusWindowOwner, NativeDesktopWorkStatusPanel, NativeDesktopWorkStatusToggle } from '../../desktop-work-status';
import { desktopWorkStatusLayout, type DesktopWorkStatusChat, type DesktopWorkStatusChild, type DesktopWorkStatusLocation } from '../../desktop-work-status-core';
import type { PageOperation } from '../../page-operations';

function Fixture() {
  const audit = (event: string, value?: unknown) => host.post('work.status.audit', { event, value });
  const scope = { host: { hostID: 'fixture', lease: 'lease-1' }, authorityKey: 'fixture-authority', sessionID: 'parent', directory: '/fixture/project' };
  const current = signal(true), interactive = signal(true), active = signal(true), preview = signal(false), expanded = signal(false), draft = signal('');
  const operation = signal<PageOperation | null>(null);
  const makeOperation = () => { let valid = true; const result: PageOperation = { scope: scope.host, generation: 1, current: () => valid && current() && active() && lifecycle() === 'active', request: async () => { throw new Error('No fixture network source'); } }; return { result, retire: () => { valid = false; } }; };
  let lane = makeOperation(); operation.set(lane.result);
  const owner = createNativeDesktopWorkStatusOwner({ scope, current, active, interactive, operation });
  const readState = owner.state;
  owner.state = (() => { audit('projection-read'); return readState(); }) as typeof owner.state;
  const window = createNativeDesktopWorkStatusWindowOwner();
  const layout = computed(() => desktopWorkStatusLayout({ windowWidth: windowSize().width, desktop: true, active: active(), expandedInput: expanded(), hasSession: true, draftConversation: false, previewOpen: preview(), rightSidebarOpen: false }, window.state()));
  let chat: DesktopWorkStatusChat = { tasks: [
    { id: 'done', content: 'Completed todo', status: 'completed', priority: 'medium' },
    { id: 'cancelled', content: 'Cancelled todo', status: 'cancelled', priority: 'medium' },
    { id: 'pending', content: 'Pending todo', status: 'pending', priority: 'medium' },
    { id: 'progress', content: 'In progress todo', status: 'in_progress', priority: 'medium' },
  ], activity: 'idle', taskFaces: [{ id: 'old', sessionID: 'child', label: 'Explore', description: 'Historical running tool', running: true }, { id: 'unresolved', label: 'Explore', description: 'Unresolved tool', running: true }], liveTaskPartIDs: new Set(), backgroundShell: { phase: 'unavailable' } };
  const location: DesktopWorkStatusLocation = { project: { label: 'Exact Project', path: '/fixture/project' }, secondaryWorktree: { label: 'Secondary worktree', path: '/fixture/tree' }, git: { phase: 'ready', value: { branch: 'feature/real', changedFiles: 2, additions: 7, deletions: 3 } } };
  owner.projection.commitChat(chat); owner.projection.commitLocation(location);
  const children = (): DesktopWorkStatusChild[] => [{ id: 'child', title: 'Authoritative child title', parentID: 'parent', directory: '/fixture/project', activity: 'idle' }];
  let fail = false, copyFail = false, hold = false, releases: Array<() => void> = [], empty = false;
  const read = async (captured: PageOperation) => {
    if (captured !== operation()) throw new Error('Wrong operation'); audit('read');
    if (hold) { hold = false; await new Promise<void>(resolve => releases.push(resolve)); }
    if (fail) throw new Error('Synthetic read failure'); return empty ? [] : children();
  };
  host.on<{ action: string; value?: boolean | number }>('work.status.control', event => {
    if (event.action === 'modal') interactive.set(event.value !== true);
    else if (event.action === 'active') active.set(event.value === true);
    else if (event.action === 'preview') preview.set(event.value === true);
    else if (event.action === 'expanded') expanded.set(event.value === true);
    else if (event.action === 'read') void owner.readChildren(read);
    else if (event.action === 'fail') fail = event.value === true;
    else if (event.action === 'copy-fail') copyFail = event.value === true;
    else if (event.action === 'empty') { empty = event.value === true; chat = { ...chat, taskFaces: [] }; owner.projection.commitChat(chat); }
    else if (event.action === 'hold') hold = true;
    else if (event.action === 'release') { const pending = releases; releases = []; pending.forEach(release => release()); }
    else if (event.action === 'lane') { lane.retire(); lane = makeOperation(); operation.set(lane.result); }
    else if (event.action === 'retire') current.set(false);
    else if (event.action === 'git-fail') owner.projection.commitLocation({ ...location, git: { phase: 'failed' } });
    else if (event.action === 'git-unknown') owner.projection.commitLocation({ ...location, git: { phase: 'unknown' } });
    else if (event.action === 'git-empty') owner.projection.commitLocation({ ...location, git: { phase: 'ready', value: { branch: null, changedFiles: 0, additions: null, deletions: null } } });
    else if (event.action === 'working') { chat = { ...chat, activity: 'working', liveTaskPartIDs: new Set(['old']) }; owner.projection.commitChat(chat); }
    else if (event.action === 'many') { chat = { ...chat, tasks: Array.from({ length: Number(event.value) }, (_, index) => ({ id: String(index), content: 'Todo ' + index, status: 'pending', priority: 'medium' })) }; owner.projection.commitChat(chat); }
    else if (event.action === 'many-children') owner.projection.commitChildren({ phase: 'ready', value: Array.from({ length: Number(event.value) }, (_, index) => ({ id: `large-${index}`, title: `Large Child ${index}`, parentID: 'parent', directory: '/fixture/project', activity: 'idle' })) });
    else if (event.action === 'finished') { chat = { ...chat, tasks: chat.tasks.slice(0, 2) }; owner.projection.commitChat(chat); }
    else if (event.action === 'snapshot') audit('snapshot', { children: readState().children, backgroundShell: readState().chat.backgroundShell, git: readState().location.git, reading: readState().readingChildren, expanded: [owner.todosExpanded(), owner.agentsExpanded()] });
    else throw new Error('Unknown fixture control');
  });
  effect(() => { const value = layout(); untracked(() => audit('layout', value)); });
  return <View class="flex-1 bg-background">
    <View style={{ height: 48 }}><NativeDesktopWorkStatusToggle owner={window} fits={layout().fits} selected={layout().selected} current={current} active={active()} interactive={interactive()} /></View>
    <View class="flex-1 relative">
      <Text testID="fixture-reserve">{layout().reserve}</Text>
      <Input testID="fixture-composer" value={draft()} onChange={event => draft.set(event.value)} style={{ width: 300, height: 60 }} />
      <NativeDesktopWorkStatusPanel owner={owner} actions={{ copyText: async text => { audit('copy', text); if (copyFail) throw new Error('Synthetic clipboard failure'); }, openGit: captured => audit('open-git', captured), openChild: target => audit('open-child', target), onError: key => audit('error', key) }}
        visible={layout().inline || layout().overlay} overlay={layout().overlay} chatBounds={{ origin: { x: 0, y: 48 }, size: { width: windowSize().width, height: windowSize().height - 48 } }} toggleBounds={{ origin: { x: 0, y: 0 }, size: { width: 28, height: 28 } }} onCloseOverlay={window.closeOverlay} />
    </View>
  </View>;
}
mount(Fixture);
