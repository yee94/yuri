import { cleanup, mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { BotEditor, TaskEditor } from './features';
import { app, captureHostRequest, epoch, loadConnections, refresh } from './state';
import { native } from './runtime';
import { language } from './i18n';
import { nativeAppearance } from './appearance';
import { createNativeAppearanceSync, type AppliedNativeAppearance } from './appearance-core';
import { record, text } from './model';

language.set('en');
mount(() => {
  const ready = signal(false), error = signal(''), audit = signal(''), openedSession = signal('');
  let appearanceSync: ReturnType<typeof createNativeAppearanceSync> | undefined;
  cleanup(() => appearanceSync?.pause());
  const nav = createNavStack<{ kind: 'root' | 'bot' | 'new-bot' | 'task' | 'new-task' }>([{ kind: 'root' }]);
  void (async () => {
    // A production native Host cannot answer this gate; no connection/Host API
    // is touched until the isolated memory Host identifies itself.
    if (await native('features.fixture.identity') !== 'features-memory-only') throw new Error('Memory-only fixture Host required');
    await loadConnections(); await refresh();
    const request = captureHostRequest(), connection = app.connection();
    if (!connection || connection.id !== 'features-memory') throw new Error('Memory appearance connection required');
    appearanceSync = createNativeAppearanceSync({
      readSettings: () => request('/api/config/settings'), readThemes: () => request('/api/config/themes'),
      reset: async scope => (await native<{ revision: number }>('appearance.reset', { hostID: scope?.hostID ?? null })).revision,
      apply: (scope, revision, appearance) => native<Pick<AppliedNativeAppearance, 'uiFontFamily' | 'monoFontFamily' | 'assistantFontFamilies' | 'unsupportedFonts' | 'systemColorScheme'>>('appearance.apply', { hostID: scope.hostID, revision, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts }),
      changed: value => nativeAppearance.current.set(value), failed: message => error.set(message),
    });
    appearanceSync.setScope({ hostID: connection.id, generation: epoch(), url: connection.url });
    await appearanceSync.refresh();
    const applied = nativeAppearance.current();
    if (error() || !applied || applied.unsupportedFonts.length) throw new Error(error() || 'Memory appearance fonts unsupported');
    ready.set(true);
  })().catch(failure => error.set(String(failure)));
  const creationContext = { projectID: 'project', directory: '/first-project', selection: { providerID: 'fixture', modelID: 'model', agent: 'build' } };
  return <NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'bot' || route.kind === 'new-bot') return <BotEditor bot={route.kind === 'bot' ? app.bots()[0] : undefined} onDone={() => nav.pop()} />;
    if (route.kind === 'task' || route.kind === 'new-task') return <TaskEditor item={route.kind === 'task' ? app.tasks()[0] : undefined} creationContext={creationContext} active={nav.routes().at(-1) === route} onOpenSession={target => { openedSession.set(target.id); nav.pop(); }} onDone={() => nav.pop()} />;
    return <NavPage title="Memory editor fixture" headerBackTitle=""><View class="p-4 gap-3"><Text testID="features-memory-error">{error()}</Text><If when={ready()}><Text testID="features-memory-ready">Memory only</Text><Each of={(['bot', 'new-bot', 'task', 'new-task'] as const)}>{kind => <Button testID={`features-memory-open-${kind()}`} class="min-h-11 bg-secondary" onPress={() => nav.push({ kind: kind() })}><Text>{kind()}</Text></Button>}</Each>
      <Button testID="features-memory-lose-bot" class="min-h-11" onPress={() => { void native('features.fixture.configure', { lose: 'POST /api/yuri/assistants' }).then(() => nav.push({ kind: 'new-bot' })); }}><Text>Lose Bot create ACK</Text></Button>
      <Button testID="features-memory-lose-task" class="min-h-11" onPress={() => { const id = text(record(app.tasks()[0]?.task).id); void native('features.fixture.configure', { lose: 'PATCH /api/projects/project/scheduled-tasks' }).then(() => { if (id) nav.push({ kind: 'task' }); }); }}><Text>Lose task update ACK</Text></Button>
      <Button testID="features-memory-audit" class="min-h-11" onPress={() => { void native('features.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Audit</Text></Button><Text testID="features-memory-audit-value">{audit()}</Text><Text testID="features-memory-opened-session">{openedSession()}</Text>
    </If></View></NavPage>;
  }}</NavStack>;
});
