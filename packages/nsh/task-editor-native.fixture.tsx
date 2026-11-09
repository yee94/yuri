import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { TaskEditor } from './features';
import { app, loadConnections } from './state';
import { language } from './i18n';

function TaskEditorFixture() {
  language.set('en');
  void loadConnections().then(() => app.projects.set([{ id: 'wrong-first', name: 'Wrong first', path: '/first' }, { id: 'actual', name: 'Actual project', path: '/actual' }, { id: 'other', name: 'Other project', path: '/other' }]));
  const nav = createNavStack<'root' | 'task'>(['root']), saved = signal(false);
  return <NavStack state={nav}>{route => route === 'task' ? <TaskEditor active={nav.routes().at(-1) === route} creationContext={{ projectID: 'actual', directory: '/actual/worktree', selection: { providerID: 'actual-provider', modelID: 'actual-model', variant: 'high', agent: 'plan' }, commandContext: { sessionID: null, hasMessages: false, hasNewDraft: false } }} onDone={() => { saved.set(true); nav.pop(); }} /> : <NavPage title="Task fixture" headerBackTitle=""><View><Button testID="task-fixture-open" onPress={() => nav.push('task')}><Text>Open Task</Text></Button><If when={saved()}><Text testID="task-fixture-finished">Finished</Text></If></View></NavPage>}</NavStack>;
}
mount(TaskEditorFixture);
