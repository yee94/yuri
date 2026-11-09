import { cleanup, mount, signal, Text, View, windowSize } from 'nsh';
import { Button } from 'nsh/base';
import { TaskEditor } from './features';
import { app, loadConnections } from './state';
import { request } from './runtime';
import { language } from './i18n';
import type { Row } from './model';
import type { TaskEditorLeave, TaskEditorWindowGuard } from './task-editor-owner';

const task = (id: string): Row => ({ projectId: 'project', task: { id, name: `Task ${id}`, enabled: true, schedule: { kind: 'daily', times: ['09:00', '18:30'], timezone: 'UTC' }, execution: { prompt: 'Existing full prompt', providerID: 'provider', modelID: 'model', agent: 'build', variant: 'high', goalEnabled: true } } });
function Fixture() {
  language.set('en'); app.tab.set(2);
  const ready = signal(false), active = signal(true), interactive = signal(true), selection = signal('a'), mounted = signal(0), disposed = signal(0), done = signal(0), closed = signal(0), left = signal(0), history = signal(0), audit = signal('');
  let leave: TaskEditorLeave | null = null;
  let windowGuard: TaskEditorWindowGuard | null = null;
  const windowStatus = signal('');
  void loadConnections().then(() => { app.projects.set([{ id: 'project', name: 'Project', path: '/workspace/project' }, { id: 'other', name: 'Other project', path: '/workspace/other' }]); ready.set(true); });
  function Owned(props: { identity: string }) {
    mounted.set(mounted() + 1); cleanup(() => disposed.set(disposed() + 1));
    return <TaskEditor presentation="desktop" item={props.identity === 'new' ? undefined : task(props.identity)} creationContext={{ projectID: 'project', directory: '/workspace/project', selection: { providerID: 'provider', modelID: 'model', agent: 'build', variant: 'high' } }}
      active={active()} interactive={interactive()} onNavigation={value => { leave = value; }} onWindowGuard={value => { windowGuard = value; }} onClose={() => closed.set(closed() + 1)} onDone={() => done.set(done() + 1)} onOpenHistory={() => history.set(history() + 1)} />;
  }
  return <View class="flex-1 bg-background"><View class="flex-1 min-h-0 flex-row"><View class="flex-1 min-w-0" /><View style={{ width: Math.min(480, Math.max(380, windowSize().width * .36)) }} class="min-h-0 border-l border-border"><If when={ready()}><Each of={[selection()]} key={identity => identity}>{identity => <Owned identity={identity()} />}</Each></If></View></View>
    <View class="gap-1 p-1"><View class="flex-row gap-2 flex-wrap">
      <Button testID="fixture-task-modal" onPress={() => interactive.set(!interactive())}><Text>Modal</Text></Button><Button testID="fixture-task-active" onPress={() => active.set(!active())}><Text>Active</Text></Button>
      <Button testID="fixture-task-leave" onPress={() => { void leave?.(() => left.set(left() + 1)); }}><Text>Leave</Text></Button><Button testID="fixture-task-switch" onPress={() => { void leave?.(() => selection.set('b')); }}><Text>Switch</Text></Button><Button testID="fixture-task-new" onPress={() => { void leave?.(() => selection.set('new')); }}><Text>New</Text></Button>
      <Button testID="fixture-task-audit" onPress={() => { void request('/fixture/audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Audit</Text></Button>
      <Button testID="fixture-task-window-request" onPress={() => { void windowGuard?.requestClose().then(value => windowStatus.set(`requested:${value}`)); }}><Text>Request close</Text></Button><Button testID="fixture-task-window-check" onPress={() => windowStatus.set(`canClose:${windowGuard?.canClose()}`)}><Text>Check close</Text></Button>
      <Each of={['normal', 'refuse', 'unknown', 'missing', 'unsynced', 'pending', 'release']}>{mode => <Button testID={`fixture-task-${mode()}`} onPress={() => { void request(`/fixture/${mode()}`); }}><Text>{mode()}</Text></Button>}</Each>
    </View><Text>{`owners:${mounted()}:${disposed()};done:${done()};close:${closed()};leave:${left()};history:${history()}`}</Text><Text>{windowStatus()}</Text><Text style={{ numberOfLines: 1 }}>{`audit:${audit()}`}</Text></View>
  </View>;
}
mount(Fixture);
