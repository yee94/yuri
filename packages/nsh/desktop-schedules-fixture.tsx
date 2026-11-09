import { cleanup, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { ScheduledHome } from './schedules';
import { app, loadConnections } from './state';
import { request } from './runtime';
import { language } from './i18n';
import { record, text } from './model';
import { taskIdentity, type TaskIdentity } from './schedules-state';

language.set('en'); app.tab.set(2);
function Fixture() {
  const active = signal(true), interactive = signal(true), audit = signal(''), event = signal('');
  const editorOpen = signal(false), selected = signal<TaskIdentity | null>(null), draft = signal(''), veto = signal(false), owners = signal(0), disposed = signal(0);
  void loadConnections().then(() => app.projects.set([{ id: 'project', path: '/workspace/project', name: 'Synthetic project' }]));
  function Editor() {
    owners.set(owners() + 1); cleanup(() => disposed.set(disposed() + 1));
    return <View testID="fixture-schedule-editor" class="flex-1 p-4 gap-2"><Text>{selected() ? `Editor:${selected()!.taskId}` : 'Editor:new'}</Text><Input testID="fixture-schedule-draft" class="h-9 bg-card text-foreground" value={draft()} disabled={!active() || !interactive()} onChange={value => { if (active() && interactive()) draft.set(value.value); }} /></View>;
  }
  return <View class="flex-1 bg-background">
    <View class="flex-1 min-h-0"><If when={!!app.connection()}><ScheduledHome presentation="desktop" active={active()} interactive={interactive()} selectedTask={selected()} editorOpen={editorOpen()} editor={<Editor />}
      requestViewChange={commit => { if (veto()) { event.set('dirty-veto'); return; } editorOpen.set(false); commit(); }}
      onCreate={() => { selected.set(null); draft.set(''); editorOpen.set(true); }} onEdit={item => { selected.set(taskIdentity(item)); draft.set(text(record(record(item.task).execution).prompt)); editorOpen.set(true); }}
      onOpenTask={() => event.set('unexpected-mobile-detail')} onOpenSession={target => event.set(`session:${target.id}:${target.directory}`)} /></If></View>
    <View class="gap-1 px-2 py-1"><View class="flex-row gap-2">
      <Button testID="fixture-schedules-modal" onPress={() => interactive.set(!interactive())}><Text>Toggle modal</Text></Button><Button testID="fixture-schedules-active" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button>
      <Button testID="fixture-schedules-veto" onPress={() => veto.set(!veto())}><Text>Toggle dirty guard</Text></Button>
      <Button testID="fixture-schedules-audit" onPress={() => { void request('/fixture/audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Audit</Text></Button>
      <Each of={['fail', 'partial', 'empty', 'refresh']}>{mode => <Button testID={`fixture-schedules-${mode()}`} onPress={() => { void request(`/fixture/${mode()}`); }}><Text>{mode()}</Text></Button>}</Each>
    </View><Text>{`editor-owners:${owners()}:${disposed()}`}</Text><Text>{event()}</Text><Text style={{ numberOfLines: 1 }}>{`audit:${audit()}`}</Text></View>
  </View>;
}
mount(Fixture);
