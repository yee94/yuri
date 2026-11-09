import { cleanup, computed, effect, lifecycle, nativeComponent, signal, untracked, View, Text, type NativeComponentRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import type { DesktopPanelScope } from './desktop-panel-model';
import { createDesktopBrowserBinding, desktopBrowserAddress, desktopBrowserComponent, type DesktopBrowserBinding, type DesktopBrowserRequest, type DesktopBrowserState } from './desktop-browser-core';

const BrowserViewport = nativeComponent<{ binding: DesktopBrowserBinding }, { browser: Record<string, unknown> }>(desktopBrowserComponent, { props: ['binding'], events: ['browser'] });
let ownerSerial = 0;
export type NativeDesktopBrowserPaneProps = {
  scope: DesktopPanelScope;
  current: () => boolean;
  active: boolean;
  /** Same retained tab can receive another URL without remounting its native view. */
  intent?: DesktopBrowserRequest;
  /** Register the tab-local request(intent) entrypoint; never an application route. */
  request?: (request: ((intent: DesktopBrowserRequest) => boolean) | null) => void;
  onNavigate?: (url: string) => void;
};
const paneIdentity = (scope: DesktopPanelScope) => JSON.stringify([scope.host.hostID, scope.host.lease, scope.authorityKey, scope.sessionID, scope.directory]);

/** A normal workbench child. It never opens a Sheet, full-screen route or WebView root. */
export function NativeDesktopBrowserPane(props: NativeDesktopBrowserPaneProps) {
  let registered: ((intent: DesktopBrowserRequest) => boolean) | null = null;
  const register = (request: (intent: DesktopBrowserRequest) => boolean) => {
    registered = request; props.request?.(request);
    return () => { if (registered === request) { registered = null; props.request?.(null); } };
  };
  return <Each of={[props.scope]} key={paneIdentity}>{scope => <BrowserPane {...props} scope={scope()} register={register} />}</Each>;
}
function BrowserPane(props: NativeDesktopBrowserPaneProps & { register: (request: (intent: DesktopBrowserRequest) => boolean) => () => void }) {
  const state = signal<DesktopBrowserState>({ phase: 'idle', url: '', canBack: false, canForward: false, error: null });
  const revision = signal(0), address = signal(''), native = signal<NativeComponentRef | null>(null), localError = signal('');
  const capturedIdentity = paneIdentity(props.scope);
  const current = () => props.current() && paneIdentity(props.scope) === capturedIdentity;
  const active = computed(() => props.active && current() && lifecycle() === 'active');
  let incoming = '';
  const binding = createDesktopBrowserBinding({ scope: props.scope.host, directory: props.scope.directory, owner: `desktop-browser-${++ownerSerial}`, current,
    changed: value => { state.set(value); address.set(value.url); },
    command: (name, receipt) => native()?.command(name, receipt),
  });
  const update = () => revision.set(revision() + 1);
  const request = (intent: DesktopBrowserRequest) => {
    try { const changed = binding.request(intent); localError.set(''); if (changed) update(); return changed; }
    catch { localError.set('browser_invalid_url'); return false; }
  };
  effect(() => { const value = active(); untracked(() => { binding.update(value); update(); }); });
  effect(() => {
    const intent = props.intent, key = intent ? JSON.stringify(intent) : '';
    if (active() && intent && key !== incoming) untracked(() => {
      incoming = key;
      if (intent.kind !== 'browser' || intent.url !== '') request(intent);
    });
  });
  const unregister = props.register(request);
  cleanup(() => { binding.dispose(); unregister(); });
  const currentBinding = computed(() => { revision(); return binding.binding(); });
  const command = (name: 'back' | 'forward' | 'reload' | 'stop' | 'external') => binding.command(name);
  const loading = () => ['preparing', 'loading'].includes(state().phase);
  const external = computed(() => { try { return desktopBrowserAddress(state().url).kind === 'browser'; } catch { return false; } });
  return <View testID="native-desktop-browser-pane" class="flex-1 bg-background">
    <View class="min-h-10 flex-row items-center gap-1 px-2 border-b border-border/30">
      <Button testID="desktop-browser-back" disabled={!active() || !state().canBack} accessibilityLabel={t('header.actions.backAria')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={() => command('back')}><Icon name="arrow-left" size={14} /></Button>
      <Button testID="desktop-browser-forward" disabled={!active() || !state().canForward} accessibilityLabel={t('chat.questionCard.next')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={() => command('forward')}><Icon name="arrow-right" size={14} /></Button>
      <Input testID="desktop-browser-address" class="flex-1 min-h-8 bg-muted rounded-md px-2 text-xs" value={address()} disabled={!active()} accessibilityLabel={t('contextPanel.browser.addressAria')} onChange={event => address.set(event.value)} onSubmit={() => request({ kind: 'browser', url: address() })} />
      <Button testID="desktop-browser-go" disabled={!active()} accessibilityLabel={t('contextPanel.browser.open')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={() => request({ kind: 'browser', url: address() })}><Icon name="arrow-right" size={14} /></Button>
      <Button testID="desktop-browser-reload" disabled={!active() || !currentBinding()} accessibilityLabel={t(loading() ? 'mobile.instances.cancelEdit' : 'contextPanel.preview.actions.reload')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={() => command(loading() ? 'stop' : 'reload')}><Icon name={loading() ? 'close' : 'refresh'} size={14} /></Button>
      <Button testID="desktop-browser-external" disabled={!active() || !external()} accessibilityLabel={t('contextPanel.preview.actions.openExternal')} class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" onPress={() => command('external')}><Icon name="external-link" size={14} /></Button>
    </View>
    <If when={!!localError() || !!state().error}><Text testID="desktop-browser-error" role="alert" class="p-2 text-xs text-destructive">{t('common.unavailable')} · {localError() || state().error}</Text></If>
    <If when={loading()}><Text testID="desktop-browser-loading" class="px-2 text-xs text-muted-foreground">{t('contextPanel.preview.loading')}</Text></If>
    <View class="flex-1 overflow-hidden">
      <If when={!!currentBinding()}><BrowserViewport testID="desktop-browser-viewport" class="flex-1" binding={currentBinding()!} ref={value => native.set(value)} onBrowser={value => {
        if (!binding.event(value)) return;
        const url = binding.snapshot().url;
        if (url && current()) props.onNavigate?.(url);
      }} /></If>
      <If when={!currentBinding()}><Text class="p-3 text-sm text-muted-foreground">{t('contextPanel.browser.emptyHint')}</Text></If>
    </View>
  </View>;
}
