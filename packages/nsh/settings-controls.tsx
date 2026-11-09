import { cleanup, effect, signal, Text, untracked, View, type JSX, type TextStyle } from 'nsh';
import { Button, Input, Switch, type SelectItem } from 'nsh/base';
import { NativeSelect as Select } from './native-select';
import { t } from './i18n';
import { app, captureHostOperation, captureHostRequest, epoch } from './state';
import { createSettingsTransaction } from './settings-protocol';
import { nativeDensity } from './appearance';

export const settingsAction = 'min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';
export const settingsField = 'min-h-12 px-3 py-3 rounded-xl bg-secondary text-foreground';
export function SettingsGroup(props: { title: string; children?: JSX.Element }) {
  return <View class="gap-2" style={nativeDensity().settings.section}><Text class="text-xs text-muted-foreground px-1" style={nativeDensity().settings.label}>{props.title}</Text><View class="rounded-2xl bg-card p-4 gap-3" style={nativeDensity().settings.card}>{props.children}</View></View>;
}
export function SettingsInput(props: { title: string; value: string; onChange: (value: string) => void; multiline?: boolean; disabled?: boolean; masked?: boolean; testID?: string; inputStyle?: TextStyle }) {
  return <View class="gap-2" style={nativeDensity().settings.section}><Text class="text-sm text-foreground">{props.title}</Text><Input testID={props.testID} class={settingsField + (props.multiline ? ' min-h-40' : '')} style={{ ...nativeDensity().settings.field, ...(props.multiline ? { minHeight: 160 * nativeDensity().scale } : {}), ...props.inputStyle }} multiline={props.multiline} value={props.value} onChange={e => props.onChange(e.value)} disabled={props.disabled} masked={props.masked} autoCapitalize="none" autoCorrect={false} accessibilityLabel={props.title} /></View>;
}
export function SettingsChoice(props: { title: string; value: string; items: SelectItem[]; onChange: (value: string) => void; disabled?: boolean; testID?: string }) {
  // Select's component host is not the press target; the native select owns behavior on this trigger.
  return <View class="gap-2" style={nativeDensity().settings.section}><Text class="text-sm text-foreground">{props.title}</Text><Select value={props.value} items={props.items} disabled={props.disabled} searchable accessibilityLabel={props.title} searchAccessibilityLabel={props.title} searchPlaceholder={props.title} popupClass="bg-card rounded-2xl p-3" popupStyle={nativeDensity().settings.popup} listClass="bg-card" itemClass="min-h-12 p-3 rounded-xl text-foreground selected:bg-accent" itemStyle={nativeDensity().settings.field} searchClass={settingsField} onChange={e => props.onChange(e.value ?? '')} trigger={<View testID={props.testID} class={settingsField} style={nativeDensity().settings.field}><Text class="text-foreground">{props.items.find(item => item.value === props.value)?.title || props.value || props.title}</Text></View>} /></View>;
}
export function SettingsToggle(props: { title: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; testID?: string }) {
  return <Switch testID={props.testID} class="min-h-12 flex-row-reverse items-center gap-3" style={nativeDensity().settings.toggle} checked={props.value} disabled={props.disabled} onChange={event => props.onChange(event.checked)} accessibilityLabel={props.title} trackClass="w-11 rounded-full bg-secondary p-0.5 checked:bg-foreground disabled:opacity-40" thumbClass="size-5 rounded-full bg-background checked:translate-x-5"><Text class="flex-1 text-sm text-foreground">{props.title}</Text></Switch>;
}
export function settingsLifetime() {
  const generation = epoch(), connection = app.connection()?.id;
  const request = captureHostRequest();
  let alive = true;
  cleanup(() => { alive = false; });
  const current = () => alive && generation === epoch() && connection === app.connection()?.id;
  const busy = signal(false), error = signal(''), notice = signal(''), ready = signal(false);
  const transaction = createSettingsTransaction(request, current);
  async function perform(work: () => Promise<void>) {
    if (busy() || !current()) return;
    busy.set(true); error.set(''); notice.set('');
    try { await work(); } catch (failure) { if (current()) error.set(failure instanceof Error ? failure.message : t('settings.voice.volcengine.saveFailed')); }
    finally { if (current()) busy.set(false); }
  }
  return { busy, error, notice, ready, current, request, transaction, perform };
}
export type SettingsHostOperation = ReturnType<typeof captureHostOperation>;
export type SettingsOperation = Readonly<SettingsHostOperation & { transaction: ReturnType<typeof createSettingsTransaction> }>;

/** Opt-in lane lifetime. Existing constructor request aliases remain fixed; pages
 * using this owner must capture an operation at every asynchronous entry. */
export function settingsOperationLifetime(initial: SettingsHostOperation | null, active: () => boolean) {
  const busy = signal(false), error = signal(''), notice = signal(''), ready = signal(false);
  const operation = signal<SettingsOperation | null>(null);
  let alive = true;
  function retireOperation() { operation.set(null); busy.set(false); }
  function replaceOperation(next: SettingsHostOperation) {
    if (!alive || !next.current()) return null;
    retireOperation();
    const current = () => alive && operation() === lane && next.current() && active();
    const request: SettingsHostOperation['request'] = async (path, method, body) => {
      if (!current()) throw new Error('settings_operation_stale');
      const result = await next.request(path, method, body);
      if (!current()) throw new Error('settings_operation_stale');
      return result;
    };
    const lane: SettingsOperation = Object.freeze({ ...next, current, request, transaction: createSettingsTransaction(request, current) });
    operation.set(lane);
    return lane;
  }
  if (initial) replaceOperation(initial);
  cleanup(() => { alive = false; retireOperation(); });
  const current = () => operation()?.current() === true;
  async function perform(work: (captured: SettingsOperation) => Promise<void>, captured = operation()) {
    if (!captured?.current() || busy()) return;
    busy.set(true); error.set(''); notice.set('');
    try { await work(captured); }
    catch (failure) { if (captured.current()) error.set(failure instanceof Error ? failure.message : t('settings.voice.volcengine.saveFailed')); }
    finally { if (operation() === captured) busy.set(false); }
  }
  return { busy, error, notice, ready, current, perform, operation, replaceOperation, retireOperation };
}
/** Persistent editor owner. Only confirmed same-Host authority replaces its lane;
 * the caller keeps form/controller state and captures operation per event. */
export function settingsPageLifetime(active: () => boolean = () => true) {
  const mounted = app.connection();
  const identity = mounted ? [mounted.id, mounted.url, mounted.authorizationID] : null;
  const state = settingsOperationLifetime(captureHostOperation(), active);
  const listeners = new Set<(operation: SettingsOperation | null) => void>();
  let retired = false;
  effect(() => {
    const connection = app.connection(); app.runtimeScope(); epoch();
    const candidate = captureHostOperation(), admitted = candidate.current();
    untracked(() => {
      if (connection && (!identity || connection.id !== identity[0] || connection.url !== identity[1] || connection.authorizationID !== identity[2])) retired = true;
      const previous = state.operation();
      if (retired || !admitted) {
        if (previous) { state.retireOperation(); listeners.forEach(listener => listener(null)); }
        return;
      }
      if (previous && previous.generation === candidate.generation && previous.scope?.hostID === candidate.scope?.hostID && previous.scope?.lease === candidate.scope?.lease) return;
      const next = state.replaceOperation(candidate);
      listeners.forEach(listener => listener(next));
    });
  });
  cleanup(() => listeners.clear());
  return { ...state, identityKey: JSON.stringify(identity), observeOperation(listener: (operation: SettingsOperation | null) => void) {
    listeners.add(listener); return () => listeners.delete(listener);
  } };
}
export function SettingsFeedback(props: { state: Pick<ReturnType<typeof settingsLifetime>, 'busy' | 'error' | 'notice'>; retry?: () => void }) {
  return <View class="gap-2"><If when={!!props.state.error()}><Text class="text-sm text-destructive">{props.state.error()}</Text></If><If when={!!props.state.notice()}><Text class="text-sm text-muted-foreground">{props.state.notice()}</Text></If><If when={!!props.retry && !!props.state.error()}><Button class={settingsAction} disabled={props.state.busy()} onPress={() => props.retry?.()}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If></View>;
}
