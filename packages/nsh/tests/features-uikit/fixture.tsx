import { effect, lifecycle, mount, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { BotEditor, TaskEditor } from '../../features';
import { NativeAppearanceSync, nativeAppearance } from '../../appearance';
import { app, captureHostOperation, epoch, loadConnections, refresh } from '../../state';
import { native } from '../../runtime';
import { language } from '../../i18n';
import { record, type Row } from '../../model';

language.set('en');
mount(() => {
  const ready = signal(false), admitted = signal(false), error = signal(''), audit = signal<Row>({}), opened = signal('');
  const nav = createNavStack<{ kind: 'root' | 'bot' | 'new-bot' | 'task' | 'new-task' | 'audit' }>([{ kind: 'root' }]);
  effect(() => {
    if (lifecycle() !== 'active') { admitted.set(false); return; }
    let alive = true;
    untracked(() => {
      admitted.set(false);
      void (async () => {
        if (await native('features.fixture.identity') !== 'features-memory-only') throw new Error('Synthetic Features Host required');
        await loadConnections();
        const operation = captureHostOperation();
        if (!alive || !operation.current()) return;
        await refresh();
        if (!alive || !operation.current()) return;
        error.set(''); ready.set(true); admitted.set(true);
      })().catch(failure => { if (alive) error.set(String(failure)); });
    });
    return () => { alive = false; };
  });
  const active = () => admitted() && lifecycle() === 'active' && captureHostOperation().current() && nativeAppearance.current()?.sourceHost?.generation === epoch() && !nativeAppearance.error();
  const context = { projectID: 'project', directory: '/first-project', selection: { providerID: 'fixture', modelID: 'model', agent: 'build' } };
  async function configure(body: Row, kind: 'new-bot' | 'task') {
    const operation = captureHostOperation();
    if (!active() || !operation.current()) return;
    try { await native('features.fixture.configure', body); if (operation.current()) nav.push({ kind }); }
    catch (failure) { if (operation.current()) error.set(String(failure)); }
  }
  async function readAudit(push = false) {
    const operation = captureHostOperation();
    try { const result = await native<Row>('features.fixture.audit'); if (operation.current()) { audit.set(result); if (push) nav.push({ kind: 'audit' }); } }
    catch (failure) { if (operation.current()) error.set(String(failure)); }
  }
  const count = (method: string, path: string) => { const requests = audit().requests; return (Array.isArray(requests) ? requests : []).filter(value => record(value).method === method && record(value).path === path).length; };
  return <View class="flex-1 bg-background"><NativeAppearanceSync /><If when={ready()}><NavStack state={nav} class="flex-1">{route => {
    const current = () => active() && nav.routes().at(-1) === route;
    if (route.kind === 'bot' || route.kind === 'new-bot') return <BotEditor bot={route.kind === 'bot' ? app.bots()[0] : undefined} active={current()} onDone={() => nav.pop()} />;
    if (route.kind === 'task' || route.kind === 'new-task') return <TaskEditor item={route.kind === 'task' ? app.tasks()[0] : undefined} creationContext={context} active={current()} onOpenSession={target => { opened.set(target.id); nav.pop(); }} onDone={() => nav.pop()} />;
    if (route.kind === 'audit') return <NavPage title="Synthetic audit" class="flex-1 bg-background"><Scroll class="flex-1" contentClass="p-5 gap-3"><Button testID="features-uikit-audit-refresh" onPress={() => { void readAudit(); }}><Text>Refresh read-only audit</Text></Button>
      <Text testID="features-uikit-count-bot-create">{String(count('POST', '/api/yuri/assistants'))}</Text><Text testID="features-uikit-count-run">{String(count('POST', '/api/projects/project/scheduled-tasks/task/run'))}</Text><Text testID="features-uikit-count-task-patch">{String(count('PATCH', '/api/projects/project/scheduled-tasks'))}</Text>
      <Text testID="features-uikit-audit-json" accessibilityLabel={JSON.stringify(audit())}>{JSON.stringify(audit())}</Text></Scroll></NavPage>;
    return <NavPage title="Features UIKit QA" class="flex-1 bg-background"><Scroll class="flex-1" contentClass="p-5 gap-3"><Text testID="features-uikit-error">{error() || nativeAppearance.error()}</Text><Text testID="features-uikit-build">{String(record(audit()).buildID || '')}</Text>
      <If when={active()}><Text testID="features-uikit-ready">Synthetic scope and native appearance ready</Text></If>
      <Button testID="features-uikit-open-bot" disabled={!active()} onPress={() => nav.push({ kind: 'bot' })}><Text>Edit Bot</Text></Button>
      <Button testID="features-uikit-open-new-bot" disabled={!active()} onPress={() => nav.push({ kind: 'new-bot' })}><Text>New Bot / restore unknown create</Text></Button>
      <Button testID="features-uikit-open-task" disabled={!active()} onPress={() => nav.push({ kind: 'task' })}><Text>Edit Task / restore unknown update</Text></Button>
      <Button testID="features-uikit-open-new-task" disabled={!active()} onPress={() => nav.push({ kind: 'new-task' })}><Text>New Task / Select and DatePicker</Text></Button>
      <Button testID="features-uikit-lose-bot" disabled={!active()} onPress={() => { void configure({ lose: 'POST /api/yuri/assistants' }, 'new-bot'); }}><Text>Lose next Bot create ACK</Text></Button>
      <Button testID="features-uikit-lose-task" disabled={!active()} onPress={() => { void configure({ lose: 'PATCH /api/projects/project/scheduled-tasks' }, 'task'); }}><Text>Lose next Task update ACK</Text></Button>
      <Button testID="features-uikit-fail-older" disabled={!active()} onPress={() => { void configure({ failRead: '/api/yuri/scheduled-task-runs?limit=20&before=memory-opaque-next&projectId=project&taskId=task' }, 'task'); }}><Text>Fail older history page once</Text></Button>
      <Button testID="features-uikit-open-audit" disabled={!active()} onPress={() => { void readAudit(true); }}><Text>Read-only audit</Text></Button><Text testID="features-uikit-opened-session">{opened()}</Text>
    </Scroll></NavPage>;
  }}</NavStack></If><If when={!ready()}><Text testID="features-uikit-loading">{error() || 'Adopting synthetic scope'}</Text></If></View>;
});
