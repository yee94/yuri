import { cleanup, colorScheme, computed, effect, Image, lifecycle, locale, reduceMotion, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, NavPage, Progress, TextView } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import claude from '../ui/src/assets/brand/history-import/claude-code.svg';
import codex from '../ui/src/assets/brand/history-import/codex.svg';
import cursor from '../ui/src/assets/model-icons/cursor.svg';
import dsh from '../ui/src/assets/model-icons/deepseek.svg';
import opencode from '../ui/src/assets/provider-logos/opencode.svg';
import { nativeAppearance } from './appearance';
import { language, t } from './i18n';
import { Icon } from './Icon';
import { app, captureHostOperation } from './state';
import { bindRawRequest } from './runtime';
import { runtimeScopeFrom } from './runtime-scope';
import { SettingsGroup, settingsAction } from './settings-controls';
import { createHistoryImport, type HistoryImportController, type HistoryImportState } from './history-import-core';
import type { SetupTourLane } from './setup-tour-operation';
import { historyPreviewLimit, historySources, importJobProgress, isImportJobFinished, NativeHistoryImportError, type HistorySource, type NativeImportJob } from './history-import-protocol';

const logos = { claude, codex, cursor, dsh, opencode };
let consumers = 0;
/** A single owner is retained by main across Tour/details/task navigation.
 * Native raw sender is immutable and preserves Host JSON error codes. */
export function createNativeHistoryImport(input: { directory?: string; onComplete?: () => void; onJobsSettled?: (ids: readonly string[]) => void; operation?: ReturnType<typeof captureHostOperation> }) {
  const connection = app.connection(), hostID = connection?.id, origin = connection?.url, authorizationID = connection?.authorizationID;
  let retiredIdentity = false;
  const identityCurrent = () => {
    if (hostID !== app.connection()?.id || origin !== app.connection()?.url || authorizationID !== app.connection()?.authorizationID) retiredIdentity = true;
    return !retiredIdentity;
  };
  const makeLane = (operation: ReturnType<typeof captureHostOperation>) => {
    const raw = bindRawRequest(runtimeScopeFrom(operation.scope));
    return { current: () => identityCurrent() && operation.current(), send: async (path: string, method?: string, body?: unknown) => {
      if (!identityCurrent() || !operation.current()) throw new Error('host_operation_stale');
      const response = await raw(path, method, body);
      if (!identityCurrent() || !operation.current()) throw new Error('host_operation_stale');
      if (response.status < 200 || response.status >= 300) {
        const data = response.body;
        const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' && /^[a-z_]+$/.test(data.code) ? data.code : 'import_failed';
        throw new NativeHistoryImportError(code, response.status);
      }
      return response.body;
    } };
  };
  const initial = makeLane(input.operation ?? captureHostOperation());
  const owner = createHistoryImport({ ...input, ...initial,
    clock: { schedule: (work, ms) => { const timer = setTimeout(work, ms); return () => clearTimeout(timer); }, cancel: handle => { if (typeof handle === 'function') handle(); } },
  });
  return { ...owner, async replaceLane(operation: ReturnType<typeof captureHostOperation> | SetupTourLane) {
    if (!identityCurrent()) { owner.dispose(); return false; }
    if (!operation.current()) return false;
    await owner.replaceLane('request' in operation ? makeLane(operation) : { send: operation.send, current: () => identityCurrent() && operation.current() }); return owner.current();
  } };
}
function observeImport(controller: HistoryImportController, active: () => boolean, kind: 'tour' | 'tasks') {
  const state = signal(controller.snapshot()), key = `history-import-${++consumers}`;
  const stop = controller.subscribe(value => { if (active() && lifecycle() === 'active' && controller.current()) state.set(value); });
  effect(() => { const value = active() && lifecycle() === 'active' && controller.current(); untracked(() => { if (value) state.set(controller.snapshot()); controller.demand(key, value, kind); }); });
  cleanup(() => { stop(); controller.demand(key, false, kind); });
  return state;
}
const intlLocale = () => language() === 'system' ? locale() : language();
const number = (value: number) => new Intl.NumberFormat(intlLocale()).format(value);

/** Both Tour and background detail use this exact thin-progress/ring recipe.
 * Resolve existing root semantic tokens, not NSH primary (neutral action).
 * Unknown root appearance stays unknown instead of inventing a color theme. */
export function historyImportProgressTokens() {
  const root = nativeAppearance.current(), mode = colorScheme(), context = root?.contextUsageTokens[mode];
  return { track: context?.subtle, fill: context?.primary, error: root?.cssVars[mode].destructive, muted: context?.muted };
}
export function NativeHistoryImportRing(props: { job: NativeImportJob; active: boolean }) {
  const failed = () => props.job.state !== 'running';
  const source = () => {
    const progress = importJobProgress(props.job), value = progress.total > 0 ? Math.min(99, Math.floor(Math.max(0, progress.completed) / progress.total * 100)) : null;
    const tokens = historyImportProgressTokens(), color = failed() ? tokens.error : tokens.muted;
    if (!color) return '';
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><g transform="rotate(-90 9 9)"><circle cx="9" cy="9" r="7.5" stroke="${color}" stroke-opacity="0.2" stroke-width="1.5"/><circle cx="9" cy="9" r="7.5" pathLength="100" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="100" stroke-dashoffset="${100 - (value ?? 22)}"/></g></svg>`);
  };
  return <Image src={source()} style={{ width: 16, height: 16, animationName: props.active && lifecycle() === 'active' && !reduceMotion() && !failed() && importJobProgress(props.job).total === 0 ? 'spin' : 'none', animationDuration: 1500, animationTimingFunction: 'linear', animationIterationCount: 'infinite' }} />;
}
export function NativeHistoryImportProgress(props: { job: NativeImportJob; stale: boolean; showBar?: boolean }) {
  const progress = () => importJobProgress(props.job), failed = () => props.job.state !== 'running' && !isImportJobFinished(props.job);
  const label = () => t(props.job.state === 'running' ? `historyImport.phase.${progress().phase}` : `historyImport.state.${props.job.state}`);
  return <View class="gap-2">
    <Text class="text-sm text-foreground">{label()}</Text>
    <If when={props.showBar !== false}><Progress testID={`history-import-progress-${props.job.id}`} value={progress().total > 0 ? Math.min(100, Math.max(0, progress().completed / progress().total * 100)) : undefined} indeterminate={progress().total === 0} accessibilityLabel={t('historyImport.progress')} trackClass="h-1 overflow-hidden rounded-full" trackStyle={{ backgroundColor: historyImportProgressTokens().track }} indicatorClass={'h-full rounded-full' + (progress().total === 0 ? ' w-1/3' : '')} indicatorStyle={{ backgroundColor: failed() ? historyImportProgressTokens().error : historyImportProgressTokens().fill }} /></If>
    <If when={progress().total > 0}><Text class="text-xs text-muted-foreground" accessibilityLabel={t('backgroundTasks.processed', { completed: number(progress().completed), total: number(progress().total) })}>{number(progress().completed)} / {number(progress().total)}</Text></If>
    <If when={!!props.job.failures}><Text class="text-xs text-destructive">{t('backgroundTasks.failedCount', { count: number(props.job.failures || 0) })}</Text></If>
    <If when={props.stale}><Text class="text-xs text-muted-foreground">{t('backgroundTasks.progressUnavailable')}</Text></If>
    <If when={!!props.job.progress?.code}><Text class="text-xs text-destructive">{t('historyImport.failed')} · {props.job.progress?.code}</Text></If>
    <Each of={props.job.results.filter(result => result.status === 'failed' || result.project === 'failed' || result.index === 'failed')}>{result => <View class="gap-1"><Text class="text-xs text-destructive">{result().code || t('historyImport.failed')}</Text><If when={result().project === 'failed' || result().index === 'failed'}><Text class="text-xs text-destructive">{t('historyImport.partialRegistration')}</Text></If></View>}</Each>
  </View>;
}

function NativeHistoryImportFeedback(props: { state: HistoryImportState; controller: HistoryImportController }) {
  const messages = () => [...new Set(Object.values(props.state.errors).filter((value): value is string => !!value))];
  return <If when={messages().length > 0}><View class="gap-2"><Each of={messages()}>{code => <Text testID="history-import-error" class="text-sm text-destructive">{t(code() === 'history_import_unsupported' ? 'historyImport.unsupported' : code() === 'resume_request_missing' ? 'backgroundTasks.originalSelectionMissing' : 'historyImport.failed')} · {code()}</Text>}</Each>
    <Button testID="history-import-retry" class={settingsAction} disabled={props.state.loading || props.state.writing || props.state.scanning} onPress={() => { void props.controller.retry(); }}><Text class="text-foreground">{t('settings.plugins.status.retry')}</Text></Button>
  </View></If>;
}

/** Embeddable Tour content. Discovery auto-loads after the successful idle job
 * snapshot, as Web does. Only primary/actions admit mutable Host work. */
export function NativeHistoryImportStep(props: { controller: HistoryImportController; active: boolean; onOpenTasks: () => void }) {
  const state = observeImport(props.controller, () => props.active, 'tour');
  const groups = computed(() => historySources.map(source => ({ ...source, sessions: (state().scan?.sessions ?? []).filter(session => session.source === source.id).slice(0, historyPreviewLimit) })).filter(source => source.sessions.length));
  const blocked = () => !props.active || lifecycle() !== 'active' || !props.controller.current() || state().writing || state().pending?.action === 'start' || state().job?.state === 'running';
  const installed = (id: HistorySource) => state().scan?.installations?.[id] === true ? 'historyImport.installed' : state().scan?.installations?.[id] === false ? 'historyImport.notDetected' : 'historyImport.installationUnknown';
  const countLabel = (id: HistorySource) => {
    const count = state().scan?.counts?.[id];
    if (count?.value == null || state().errors.scan) return '';
    return t(count.approximate ? 'historyImport.estimatedCount' : 'historyImport.sourceCount', { count: number(count.value) });
  };
  const receiptID = signal('');
  const headerJob = () => { state(); return props.controller.headerJob(); };
  return <View testID="history-import-step" class="gap-5">
    <Text class="text-base text-foreground">{t('historyImport.heading')}</Text><Text class="text-sm text-muted-foreground">{t('historyImport.deduplication')}</Text><Text class="text-xs text-muted-foreground">{t('historyImport.host')}</Text>
    <NativeHistoryImportFeedback state={state()} controller={props.controller} />
    <If when={!!headerJob()}><SettingsGroup title={t('backgroundTasks.import')}>
      <NativeHistoryImportProgress job={headerJob()!} stale={!!state().errors.job} showBar={headerJob()?.state === 'running'} />
      <Button testID="history-import-receipt" class={settingsAction} disabled={state().writing} onPress={() => { const job = state().job; if (job) { receiptID.set(job.id); void props.controller.inspect(job.id); } }}><Text class="text-foreground">{t('historyImport.review')}</Text></Button>
      <If when={state().job?.state === 'running'}><Button testID="history-import-cancel" class={settingsAction} disabled={state().writing || state().pendingActions.some(action => action.action !== 'start' && action.id === state().job?.id) || state().cancelRequested.includes(state().job?.id || '')} onPress={() => { const job = state().job; if (job) void props.controller.cancel(job.id); }}><Text class="text-foreground">{t('historyImport.cancel')}</Text></Button></If>
    </SettingsGroup></If>
    <SettingsGroup title={t('historyImport.sources')}><Each of={historySources}>{source => <Button testID={`history-import-source-${source().id}`} class="min-h-16 flex-row items-center gap-3 selected:bg-accent" selected={state().selected.includes(source().id)} disabled={blocked()} accessibilityLabel={`${source().name} · ${t(installed(source().id))} ${countLabel(source().id)}`} onPress={() => props.controller.select(source().id, !state().selected.includes(source().id))}>
      <Image src={logos[source().id]} style={{ width: 30, height: 30 }} /><View class="flex-1 gap-1"><Text class="text-base text-foreground">{source().name}</Text><Text class="text-xs text-muted-foreground">{t(installed(source().id))}</Text><If when={!!countLabel(source().id)}><If when={state().scanning}><Text class="text-xs text-muted-foreground">{t('historyImport.scanning')}</Text></If><If when={!state().scanning}><Text class="text-xs text-muted-foreground">{countLabel(source().id)}</Text></If></If></View><Icon name={state().selected.includes(source().id) ? 'checkbox-circle' : 'checkbox-blank'} />
    </Button>}</Each></SettingsGroup>
    <If when={state().scan && !state().scanning && !state().errors.scan && !state().scan?.sessions.length && !state().scan?.errors.length}><Text class="text-sm text-muted-foreground">{t('historyImport.empty')}</Text></If>
    <If when={!!state().scan?.errors.length}><Text class="text-xs text-destructive">{t('historyImport.scanErrors', { count: state().scan?.errors.length || 0 })}</Text><Each of={state().scan?.errors || []}>{error => <Text class="text-xs text-destructive">{historySources.find(source => source.id === error().source)?.name} · {error().code}</Text>}</Each></If>
    <If when={!!state().errors.badges}><Button class={settingsAction} disabled={blocked()} onPress={() => { void props.controller.refreshBadges(); }}><Text class="text-foreground">{t('settings.plugins.status.retry')}</Text></Button></If>
    <Each of={groups()}>{group => <SettingsGroup title={group().name}>
      <Button testID={`history-import-group-${group().id}`} class={settingsAction} selected={state().selected.includes(group().id)} disabled={blocked()} onPress={() => props.controller.select(group().id, !state().selected.includes(group().id))}><Text class="text-foreground">{group().name} {countLabel(group().id)}</Text><Icon name={state().selected.includes(group().id) ? 'checkbox-circle' : 'checkbox-blank'} /></Button>
      <Each of={group().sessions}>{session => <View testID={`history-import-preview-${session().key}`} class="gap-2 py-2">
        <View class="flex-row items-center gap-2"><Image src={logos[session().source]} style={{ width: 20, height: 20 }} /><Text class="flex-1 text-sm text-foreground">{session().title}</Text></View>
        <If when={!state().errors.badges && state().badgeScanID === state().scan?.id && state().badges?.states[session().key] === 'imported'}><Text class="text-xs text-muted-foreground">{t('historyImport.alreadyImported')}</Text></If>
        <If when={(session().updated || 0) > 0}><Text class="text-xs text-muted-foreground">{new Intl.DateTimeFormat(intlLocale(), { month: 'short', day: 'numeric' }).format(session().updated)}</Text></If>
        <If when={!!session().excerpt}><Text class="text-sm text-muted-foreground">{session().excerpt}</Text></If>
      </View>}</Each>
    </SettingsGroup>}</Each>
    <Button testID="history-import-open-tasks" class={settingsAction} disabled={!props.onOpenTasks || !props.active} onPress={() => { if (props.active && lifecycle() === 'active' && props.controller.current() && !state().writing) props.onOpenTasks?.(); }}><Text class="text-foreground">{t('backgroundTasks.title')}</Text></Button>
    <Sheet open={!!receiptID()} closeOnSwipe onOpenChange={event => { if (!event.open) receiptID.set(''); }} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: '85%' }} backdropClass="bg-background/50"><Scroll class="flex-1" contentClass="p-5 gap-4 pb-10"><NativeHistoryImportFeedback state={state()} controller={props.controller} /><If when={!!state().receipts[receiptID()]}><NativeHistoryImportReceipt job={state().receipts[receiptID()]} /></If><Button class={settingsAction} disabled={state().writing} onPress={() => { void props.controller.inspect(receiptID()); }}><Text class="text-foreground">{t('settings.plugins.status.retry')}</Text></Button><Button class={settingsAction} onPress={() => receiptID.set('')}><Text class="text-foreground">{t('onboarding.common.actions.back')}</Text></Button></Scroll></Sheet>
  </View>;
}

/** Full RECEIVED receipt projection: server status bounds results to <=80. Never
 * labels this bounded response a complete transcript or reconstructs settings. */
export function NativeHistoryImportReceipt(props: { job: NativeImportJob }) {
  return <View class="gap-4"><Text class="text-base text-foreground">{t('historyImport.review')}</Text><NativeHistoryImportProgress job={props.job} stale={false} /><Text class="text-xs text-muted-foreground">{props.job.id}</Text>
    <Each of={props.job.results}>{result => <View class="gap-1"><Text class={result().status === 'failed' ? 'text-sm text-destructive' : 'text-sm text-foreground'}>{result().phase} · {result().status}</Text><Text class="text-xs text-muted-foreground">{result().key}</Text><If when={!!result().code}><Text class="text-xs text-destructive">{result().code}</Text></If><If when={!!result().directory}><Text class="text-xs text-muted-foreground">{result().directory}</Text></If><If when={!!result().sessionID}><Text class="text-xs text-muted-foreground">{result().sessionID}</Text></If><If when={!!result().target}><Text class="text-xs text-muted-foreground">{result().target}</Text></If><If when={!!result().project || !!result().index}><Text class="text-xs text-muted-foreground">{result().project} · {result().index}</Text></If></View>}</Each>
    <TextView document={{ blocks: [{ type: 'codeBlock', code: JSON.stringify(props.job, null, 2) }] }} selectable class="text-xs text-foreground" />
  </View>;
}

export function NativeHistoryImportPage(props: { controller: HistoryImportController; active: boolean; onDismiss?: () => void; onComplete: () => void; onOpenTasks: () => void }) {
  const state = observeImport(props.controller, () => props.active, 'tour');
  const stopCompletion = props.controller.observeCompletion(() => { if (props.active && lifecycle() === 'active' && props.controller.current()) props.onComplete(); });
  cleanup(stopCompletion);
  const primary = () => { state(); return props.controller.primary(); };
  const navigate = (work: () => void) => { if (props.active && lifecycle() === 'active' && props.controller.current() && !state().writing) work(); };
  return <NavPage testID="history-import-page" title={t('historyImport.heading')} headerBackTitle="" class="flex-1 bg-background" popOnBack={!state().writing} onDismiss={props.onDismiss}>
    <Scroll class="flex-1" contentClass="p-5 gap-5 pb-6"><NativeHistoryImportStep controller={props.controller} active={props.active} onOpenTasks={props.onOpenTasks} /></Scroll>
    <View class="flex-row flex-wrap justify-end gap-2 p-4" style={{ glassEffect: 'regular' }}><Button class={settingsAction} disabled={state().writing} onPress={() => navigate(props.onComplete)}><Text class="text-foreground">{t('tour.later')}</Text></Button><Button testID="history-import-next" class={settingsAction} disabled={primary().disabled} onPress={() => { void props.controller.proceed(); }}><Text class="text-foreground">{t(primary().background ? 'historyImport.background' : 'historyImport.next')}</Text></Button></View>
  </NavPage>;
}

/** Main may mount this beside OTHER background-task owners; it starts no task. */
export function NativeHistoryImportTaskEntry(props: { controller: HistoryImportController; active: boolean; onOpen: () => void }) {
  const state = observeImport(props.controller, () => props.active, 'tasks');
  const tasks = () => { state(); return props.controller.tasks(); };
  return <If when={tasks().length > 0}><Button testID="history-import-task-entry" class="min-h-11 px-3 flex-row items-center gap-2" accessibilityLabel={t('backgroundTasks.title')} onPress={() => { if (props.active && lifecycle() === 'active' && props.controller.current()) props.onOpen(); }}><Each of={tasks()}>{task => <NativeHistoryImportRing job={task().job} active={props.active} />}</Each><Text class="text-xs text-muted-foreground">{t('backgroundTasks.import')}</Text></Button></If>;
}

export function NativeHistoryImportTasksPage(props: { controller: HistoryImportController; active: boolean; onDismiss?: () => void }) {
  const state = observeImport(props.controller, () => props.active, 'tasks');
  const tasks = () => { state(); return props.controller.tasks(); }, receiptID = signal('');
  const blocked = () => !props.active || lifecycle() !== 'active' || !props.controller.current() || state().writing;
  return <NavPage testID="history-import-tasks-page" title={t('backgroundTasks.title')} headerBackTitle="" class="flex-1 bg-background" popOnBack={!state().writing} onDismiss={props.onDismiss}><Scroll class="flex-1" contentClass="p-5 gap-5 pb-10">
    <NativeHistoryImportFeedback state={state()} controller={props.controller} />
    <If when={state().jobsReady && !tasks().length && !state().errors.jobs}><Text class="text-sm text-muted-foreground">{t('backgroundTasks.empty')}</Text></If>
    <Each of={tasks()}>{task => <SettingsGroup title={t('backgroundTasks.import')}><View class="flex-row items-center gap-3"><NativeHistoryImportRing job={task().job} active={props.active} /><Text class="flex-1 text-xs text-muted-foreground">{task().job.id}</Text></View><NativeHistoryImportProgress job={task().job} stale={task().stale} />
      <Button testID={`history-import-inspect-${task().job.id}`} class={settingsAction} disabled={blocked()} onPress={() => { receiptID.set(task().job.id); void props.controller.inspect(task().job.id); }}><Text class="text-foreground">{t('historyImport.review')}</Text></Button>
      <If when={task().failed}><Button testID={`history-import-recover-${task().job.id}`} class={settingsAction} disabled={blocked() || task().busy} onPress={() => { if (task().removeAction) void props.controller.dismiss(task().job.id); else void props.controller.resume(task().job.id); }}><Text class="text-foreground">{t(task().removeAction ? state().writing ? 'backgroundTasks.removing' : 'backgroundTasks.dismiss' : state().writing ? 'backgroundTasks.resuming' : 'backgroundTasks.resume')}</Text></Button></If>
      <If when={!task().failed}><Button class={settingsAction} disabled={blocked() || task().busy || state().cancelRequested.includes(task().job.id)} onPress={() => { void props.controller.cancel(task().job.id); }}><Text class="text-foreground">{t('historyImport.cancel')}</Text></Button></If>
    </SettingsGroup>}</Each>
    <Button class={settingsAction} disabled={blocked()} onPress={() => { void props.controller.refresh(); }}><Text class="text-foreground">{t('settings.plugins.status.retry')}</Text></Button>
  </Scroll><Sheet open={!!receiptID()} closeOnSwipe onOpenChange={event => { if (!event.open) receiptID.set(''); }} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: '85%' }} backdropClass="bg-background/50"><Scroll class="flex-1" contentClass="p-5 gap-4 pb-10"><NativeHistoryImportFeedback state={state()} controller={props.controller} /><If when={!!state().receipts[receiptID()]}><NativeHistoryImportReceipt job={state().receipts[receiptID()]} /></If><Button class={settingsAction} disabled={blocked()} onPress={() => { void props.controller.inspect(receiptID()); }}><Text class="text-foreground">{t('settings.plugins.status.retry')}</Text></Button><Button class={settingsAction} onPress={() => receiptID.set('')}><Text class="text-foreground">{t('onboarding.common.actions.back')}</Text></Button></Scroll></Sheet></NavPage>;
}
