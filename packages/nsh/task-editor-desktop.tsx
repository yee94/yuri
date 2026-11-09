import { effect, Scroll, signal, Text, View, type JSX, type Signal } from 'nsh';
import { Button, Checkbox, DatePicker, Input, Menu, MenuItem, Select, TimeField, type SelectItem } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { app } from './state';
import { record, text, type Row } from './model';
import { TaskEditorPrompt } from './task-editor-prompt';
import { CRON_EXAMPLES } from './features-cron';
import type { createTaskEditorOwner } from './task-editor-owner';
import type { TaskEditorCreationContext } from './task-editor-defaults';

type Form = { [K in 'taskID' | 'name' | 'prompt' | 'projectID' | 'kind' | 'timezone' | 'time' | 'date' | 'cron']: Signal<string> } & {
  goalEnabled: Signal<boolean>; enabled: Signal<boolean>; times: Signal<string[]>; weekdays: Signal<number[]>;
};
type Catalog = {
  providers: () => Row[]; agents: () => Row[]; loading: () => boolean; error: () => string; partial: () => boolean;
  providerID: Signal<string>; modelID: Signal<string>; agent: Signal<string>; variant: Signal<string>;
  variants: () => string[]; selectProvider: (value: string) => void; selectModel: (value: string) => void; load: (directory: string | null) => Promise<void>;
};
const quiet = 'size-8 rounded-lg items-center justify-center hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-40';
const action = 'min-h-8 px-3 rounded-lg bg-secondary items-center justify-center hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-40';
const input = 'h-8 px-2 rounded-md text-sm text-foreground text-right hover:bg-muted focus:bg-muted disabled:opacity-40';
const menuItem = 'px-2 py-2 rounded-md flex-row items-center gap-2 hover:bg-accent focus:bg-accent disabled:opacity-40';

/** Web ScheduledTaskEditorDialog's panel surface; all form/operation state is injected. */
export function TaskEditorDesktop(props: {
  form: Form; catalog: Catalog; owner: ReturnType<typeof createTaskEditorOwner>; savedTask: Row; disabled: boolean;
  capturedHost: string; creationID: string; directory: string; creationContext?: TaskEditorCreationContext; active: boolean;
  preview: { runs: string[]; loading: boolean; error: string; valid: boolean };
  onSave: () => void; onDelete: () => void; onRun: () => void; onToggle: () => void; onClose: () => void;
  onHistory?: () => void; onRecover: () => void; onFinish: () => void; onReload: () => void;
}) {
  const f = props.form, c = props.catalog, owner = props.owner, menu = signal(false);
  const can = () => !props.disabled && owner.admitted();
  const change = (work: () => void) => { if (can()) { owner.invalidateCloseGrant(); work(); } };
  effect(() => { if (!can()) menu.set(false); });
  function RowField(item: { title: string; children?: JSX.Element; stack?: boolean; required?: boolean }) {
    return <View class={`min-w-0 min-h-[52px] px-3.5 py-[11px] border-b border-border/30 gap-3 ${item.stack ? '' : 'flex-row items-center'}`}>
      <Text class="text-sm text-foreground" style={{ maxWidth: item.stack ? undefined : '42%' }}>{item.title}{item.required ? ' *' : ''}</Text>
      <View class={`min-w-0 ${item.stack ? '' : 'flex-1 items-end'}`}>{item.children}</View>
    </View>;
  }
  function Choice(item: { title: string; value: string; items: SelectItem[]; testID: string; disabled?: boolean; onChange: (value: string) => void }) {
    return <Select class="w-full min-w-0" value={item.value} items={item.items} disabled={!can() || item.disabled} searchable accessibilityLabel={item.title} searchAccessibilityLabel={item.title} searchPlaceholder={item.title}
      popupClass="bg-card border border-border rounded-lg p-1 shadow-lg" listClass="bg-transparent" itemClass="min-h-8 px-2 py-1.5 rounded-md text-sm text-foreground selected:bg-accent focus:bg-accent" searchClass="h-8 px-2 text-sm text-foreground bg-muted rounded-md"
      onChange={event => change(() => item.onChange(event.value ?? ''))} trigger={<View testID={item.testID} class={`${input} flex-row items-center justify-end gap-1 w-full`}><Text class="flex-1 text-sm text-foreground text-right" style={{ numberOfLines: 1 }}>{item.items.find(option => option.value === item.value)?.title || item.value || t('common.unavailable')}</Text><Icon name="arrow-down-s" size={14} /></View>} />;
  }
  const modelItems = () => c.providers().flatMap(provider => Object.entries(record(provider.models)).flatMap(([id, value]) => ['', ...Object.keys(record(record(value).variants))].map(variant => ({ value: JSON.stringify([provider.id, id, variant]), title: (text(record(value).name) || id) + (variant ? ` · ${variant}` : ''), group: text(provider.name) || text(provider.id) }))));
  const weekdays = () => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day, value) => ({ value, title: t(`sessions.scheduledTasks.dialog.schedule.weekdayShort.${day}` as Parameters<typeof t>[0]) }));
  function Time(item: { value: string; testID: string; onChange: (value: string) => void }) {
    return <TimeField testID={item.testID} class="flex-row min-h-8 rounded-md px-2 hover:bg-muted focus-within:bg-muted" value={item.value} disabled={!can()} onChange={event => change(() => item.onChange(event.value))} precision="minute" segmentClass="min-h-8 min-w-5 text-sm text-foreground focus:bg-accent" separatorClass="text-sm text-foreground" accessibilityLabel={t('sessions.scheduledTasks.editor.time.label')} />;
  }
  return <View testID="task-editor-desktop" class="flex-1 min-w-0 min-h-0 bg-background">
    <View class="px-6 pt-5 pb-4">
      <View class="flex-row items-center justify-between gap-3"><Text class="flex-1 text-xs font-medium text-muted-foreground">{f.taskID() ? t(props.savedTask.enabled === true ? 'sessions.scheduledTasks.dialog.taskToggle.enabled' : 'sessions.scheduledTasks.dialog.taskToggle.paused') : t('sessions.scheduledTasks.editor.title.new')}</Text>
        <View class="flex-row gap-1 items-center"><If when={!!f.taskID()}><Menu open={menu() && can()} onOpenChange={event => menu.set(event.open && can())} align="end" popupClass="bg-card border border-border rounded-lg p-1 shadow-lg" trigger={<Button testID="task-editor-more" class={quiet} disabled={!can()} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: f.name() })}><Icon name="more-2" size={16} /></Button>}>
          <MenuItem class={menuItem} disabled={!can() || props.savedTask.enabled !== true || record(props.savedTask.state).lastStatus === 'running'} onSelect={() => change(props.onRun)}><Icon name="play" size={16} /><Text class="text-sm text-foreground">{t('sessions.scheduledTasks.dialog.actions.runNow')}</Text></MenuItem>
          <MenuItem class={menuItem} disabled={!can() || !props.onHistory} onSelect={() => change(() => props.onHistory?.())}><Icon name="history" size={16} /><Text class="text-sm text-foreground">{t('sessions.scheduledTasks.workspace.views.history')}</Text></MenuItem>
          <MenuItem class={menuItem} disabled={!can()} onSelect={() => change(props.onToggle)}><Icon name={props.savedTask.enabled ? 'pause' : 'play'} size={16} /><Text class="text-sm text-foreground">{t(props.savedTask.enabled ? 'sessions.scheduledTasks.dialog.actions.pause' : 'sessions.scheduledTasks.dialog.actions.resume')}</Text></MenuItem>
          <MenuItem class={menuItem} disabled={!can()} onSelect={() => change(props.onDelete)}><Icon name="delete-bin" size={16} /><Text class="text-sm text-destructive">{t('sessions.scheduledTasks.dialog.actions.delete')}</Text></MenuItem>
        </Menu><Button testID="task-editor-toggle" class={quiet} disabled={!can()} accessibilityLabel={t(props.savedTask.enabled ? 'sessions.scheduledTasks.dialog.taskToggle.pauseAria' : 'sessions.scheduledTasks.dialog.taskToggle.enableAria', { taskName: f.name() })} onPress={() => change(props.onToggle)}><Icon name={props.savedTask.enabled ? 'pause' : 'play'} size={16} /></Button></If>
        <Button testID="features-task-cancel" class={quiet} disabled={!owner.admitted() || owner.busy() || owner.unknown()} accessibilityLabel={t('sessions.scheduledTasks.editor.actions.cancel')} onPress={props.onClose}><Icon name="close" size={16} /></Button></View>
      </View>
      <Input testID="features-task-name" class="h-9 mt-1 text-lg font-semibold text-foreground" maxLength={80} value={f.name()} disabled={!can()} onChange={event => change(() => f.name.set(event.value))} placeholder={t('sessions.scheduledTasks.editor.taskName.placeholder')} accessibilityLabel={t('sessions.scheduledTasks.editor.taskName.label')} />
    </View>
    <Scroll testID="task-editor-scroll" class="flex-1 min-h-0" contentClass="px-6 pt-2 pb-6 gap-6">
      <TaskEditorPrompt presentation="desktop" value={f.prompt()} onChange={value => change(() => f.prompt.set(value))} fieldClass="bg-card rounded-xl px-4 pt-4 text-base text-foreground" disabled={!can()} scope={{ host: props.capturedHost, draft: `task-editor:${f.projectID()}:${f.taskID() || props.creationID}`, directory: props.directory }} active={props.active} current={owner.admitted} commandContext={props.creationContext?.commandContext} />
      <View class="gap-2"><Text class="text-xs text-muted-foreground px-2">{t('sessions.scheduledTasks.editor.panel.details')}</Text><View class="min-w-0 bg-card border border-border/30 rounded-2xl overflow-hidden">
        <RowField title={t('sessions.scheduledTasks.dialog.project.label')}><Choice testID="task-editor-project" title={t('sessions.scheduledTasks.dialog.project.label')} value={f.projectID()} items={app.projects().map(project => ({ value: project.id, title: project.name }))} disabled={!!f.taskID()} onChange={value => f.projectID.set(value)} /></RowField>
        <RowField title={t('sessions.scheduledTasks.editor.model.label')} required><Choice testID="task-editor-model" title={t('sessions.scheduledTasks.editor.model.label')} value={JSON.stringify([c.providerID(), c.modelID(), c.variant()])} items={modelItems()} disabled={c.loading()} onChange={value => { const [provider, model, variant] = JSON.parse(value) as string[]; c.selectProvider(provider); c.selectModel(model); c.variant.set(variant); }} /></RowField>
        <RowField title={t('sessions.scheduledTasks.editor.agent.label')}><Choice testID="task-editor-agent" title={t('sessions.scheduledTasks.editor.agent.label')} value={c.agent()} items={[{ value: '', title: t('sessions.scheduledTasks.editor.thinkingLevel.default') }, ...c.agents().map(agent => ({ value: text(agent.id), title: text(agent.name) || text(agent.id) }))]} disabled={c.loading()} onChange={value => c.agent.set(value)} /></RowField>
        <RowField title={t('sessions.scheduledTasks.editor.goal.label')}><Checkbox testID="features-goal" checked={f.goalEnabled()} disabled={!can()} accessibilityLabel={t('sessions.scheduledTasks.editor.goal.aria')} class="size-4 rounded border border-border checked:bg-foreground items-center justify-center" onChange={event => change(() => f.goalEnabled.set(event.checked))}><If when={f.goalEnabled()}><Icon name="check" size={12} tone="background" /></If></Checkbox></RowField>
        <If when={c.loading()}><Text class="text-xs text-muted-foreground py-2">{t('common.loading')}</Text></If>
        <If when={!!c.error() || c.partial()}><View class="py-2 gap-2"><Text role="alert" class="text-xs text-destructive">{c.error() || t('assistants.state.staleSnapshot')}</Text><Button testID="task-editor-catalog-retry" class={action} disabled={!can() || c.loading()} onPress={() => change(props.onReload)}><Text class="text-xs text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></View></If>
      </View></View>
      <View class="gap-2"><Text class="text-xs text-muted-foreground px-2">{t('sessions.scheduledTasks.editor.panel.frequency')}</Text><View class="min-w-0 bg-card border border-border/30 rounded-2xl overflow-hidden">
        <RowField title={t('sessions.scheduledTasks.editor.scheduleType.label')}><Choice testID="task-editor-kind" title={t('sessions.scheduledTasks.editor.scheduleType.label')} value={f.kind()} items={(['daily', 'weekly', 'once', 'cron'] as const).map(value => ({ value, title: t(`sessions.scheduledTasks.editor.scheduleType.${value}`) }))} onChange={value => { f.kind.set(value); if (value === 'cron' && !f.cron()) f.cron.set('0 * * * *'); }} /></RowField>
        <RowField title={t('sessions.scheduledTasks.editor.timezone.label')}><Input testID="task-editor-timezone" class={input + ' w-full'} value={f.timezone()} disabled={!can()} onChange={event => change(() => f.timezone.set(event.value))} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('sessions.scheduledTasks.editor.timezone.label')} /></RowField>
        <If when={f.kind() === 'weekly'}><RowField title={t('sessions.scheduledTasks.editor.weekdays.label')} stack><View class="flex-row flex-wrap justify-end gap-3"><Each of={weekdays()}>{day => <Checkbox testID={`task-editor-weekday-${day().value}`} checked={f.weekdays().includes(day().value)} disabled={!can()} class="flex-row items-center gap-1 min-h-6" accessibilityLabel={day().title} onChange={event => change(() => f.weekdays.set(event.checked ? [...f.weekdays(), day().value] : f.weekdays().filter(value => value !== day().value)))}><Icon name={f.weekdays().includes(day().value) ? 'checkbox-circle' : 'checkbox-blank'} size={14} /><Text class="text-xs text-foreground">{day().title}</Text></Checkbox>}</Each></View></RowField></If>
        <If when={f.kind() === 'daily' || f.kind() === 'weekly'}><RowField title={t('sessions.scheduledTasks.editor.times.label')}><View class="flex-row flex-wrap justify-end items-center gap-2"><Each of={f.times().map((_, index) => index)}>{index => <View class="flex-row items-center gap-1"><Time testID={`task-editor-time-${index()}`} value={f.times()[index()] || ''} onChange={value => f.times.set(f.times().map((previous, i) => i === index() ? value : previous))} /><If when={f.times().length > 1}><Button testID={`task-editor-remove-time-${index()}`} class={quiet} disabled={!can()} accessibilityLabel={t('sessions.scheduledTasks.editor.times.removeAria')} onPress={() => change(() => f.times.set(f.times().filter((_, i) => i !== index())))}><Icon name="close" size={14} /></Button></If></View>}</Each><Button testID="task-editor-add-time" class={quiet} disabled={!can()} accessibilityLabel={t('sessions.scheduledTasks.editor.times.add')} onPress={() => change(() => f.times.set([...f.times(), '09:00']))}><Icon name="add" size={16} /></Button></View></RowField></If>
        <If when={f.kind() === 'once'}><RowField title={t('sessions.scheduledTasks.editor.date.label')}><DatePicker testID="features-date" value={f.date()} disabled={!can()} onChange={event => change(() => { if (typeof event.value === 'string') f.date.set(event.value); })} popupClass="bg-card border border-border rounded-xl p-3" calendarClass="gap-2" headerClass="flex-row items-center justify-between min-h-8" bodyClass="gap-1" rowClass="flex-row gap-1" itemClass="min-h-8 min-w-8 rounded-md items-center justify-center selected:bg-accent focus:bg-accent text-sm text-foreground" trigger={<View class={input}><Text class="text-sm text-foreground">{f.date()}</Text></View>} accessibilityLabel={t('sessions.scheduledTasks.editor.date.label')} /></RowField><RowField title={t('sessions.scheduledTasks.editor.time.label')}><Time testID="task-editor-once-time" value={f.time()} onChange={value => f.time.set(value)} /></RowField></If>
        <If when={f.kind() === 'cron'}><RowField title={t('sessions.scheduledTasks.editor.cronExpression.label')}><Input testID="features-cron" class={input + ' w-full font-mono'} value={f.cron()} disabled={!can()} onChange={event => change(() => f.cron.set(event.value))} autoCapitalize="none" autoCorrect={false} placeholder={t('sessions.scheduledTasks.editor.cronExpression.placeholder')} accessibilityLabel={t('sessions.scheduledTasks.editor.cronExpression.label')} /><If when={!props.preview.valid}><Text class="text-xs text-destructive">{t('sessions.scheduledTasks.editor.validation.cronInvalid')}</Text></If></RowField>
          <If when={props.preview.runs.length > 0}><RowField title={t('sessions.scheduledTasks.editor.cronExpression.nextRuns')} stack><View class="flex-row flex-wrap gap-x-4 gap-y-1"><Each of={props.preview.runs}>{value => <Text testID="features-cron-next-run" class="text-xs text-muted-foreground">{value()}</Text>}</Each></View></RowField></If>
          <If when={props.preview.loading}><Text class="text-xs text-muted-foreground py-2">{t('common.loading')}</Text></If><If when={!!props.preview.error}><Text testID="features-cron-preview-error" role="alert" class="text-xs text-destructive py-2">{props.preview.error}</Text></If>
          <RowField title={t('sessions.scheduledTasks.editor.cronExpression.examples')} stack><View class="flex-row flex-wrap gap-1.5"><Each of={CRON_EXAMPLES}>{example => <Button class={action} selected={f.cron().trim() === example().expression} disabled={!can()} onPress={() => change(() => f.cron.set(example().expression))}><Text class="text-xs text-foreground">{t(example().labelKey as Parameters<typeof t>[0])}</Text></Button>}</Each></View></RowField>
        </If>
      </View></View>
    </Scroll>
    <View class="border-t border-border/50 px-6 py-3 gap-2 bg-background">
      <If when={owner.unknown()}><Text testID="task-editor-unknown" role="alert" class="text-xs text-destructive">{t('sessions.scheduledTasks.dialog.title')} · {t('mcpDropdown.status.unknown')}</Text></If>
      <If when={!!owner.error()}><Text role="alert" class="text-xs text-destructive">{owner.error()}</Text></If><If when={!!owner.notice()}><Text class="text-xs text-muted-foreground">{owner.notice()}</Text></If>
      <View class="flex-row justify-end gap-2"><If when={owner.unknown()}><Button testID="task-editor-recover" class={action} disabled={!owner.admitted() || owner.busy()} onPress={props.onRecover}><Text class="text-sm text-foreground">{t('chat.questionDelegate.refreshStatus')}</Text></Button></If>
        <If when={owner.committed()} else={<Button testID="features-task-save" class={action} disabled={!can()} onPress={() => change(props.onSave)}><Text class="text-sm text-foreground">{t(owner.busy() ? 'sessions.scheduledTasks.editor.actions.saving' : f.taskID() ? 'sessions.scheduledTasks.editor.actions.save' : 'sessions.scheduledTasks.dialog.actions.create')}</Text></Button>}><Button testID="task-editor-done" class={action} disabled={!owner.admitted() || owner.busy() || owner.unknown()} onPress={props.onFinish}><Text class="text-sm text-foreground">{t('gitView.common.done')}</Text></Button></If>
      </View>
    </View>
  </View>;
}
