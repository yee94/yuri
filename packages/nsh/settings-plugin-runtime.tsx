import { cleanup, Clipboard, effect, signal, Text, untracked, View } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { t } from './i18n';
import { text, type Row } from './model';
import { SettingsFeedback, SettingsGroup, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { findRuntimeMatches, nativePluginRewrite, nativePluginTarget, readNativePluginInventory, readNativePluginRegistry, reloadNativePlugins, resolveEffectivePluginVersion, resolveLoadState, resolveUpdateFlag, updateNativePlugin, type PluginRuntimeInfo } from './settings-plugin-runtime-core';

export function SettingsPluginRuntime(props: { item: Row; directory?: string; disabled: boolean; onUpdated: (spec?: string) => void; onBusy: (value: boolean) => void }) {
  const state = settingsPageLifetime(), registryState = settingsPageLifetime();

  const directory = props.directory;
  const current = () => state.current() && props.directory === directory;
  const inventory = signal<PluginRuntimeInfo[] | null>(null), registry = signal<Row | null>(null), expanded = signal(false);
  effect(() => { const busy = state.busy() || registryState.busy(); untracked(() => props.onBusy(busy)); });
  cleanup(() => props.onBusy(false));
  const target = () => nativePluginTarget(props.item);
  const currentRegistry = () => { const selected = target(); return selected?.kind === 'package' && registry()?.spec === selected.target ? registry() : null; };
  const matches = () => { const selected = target(); return selected && inventory() ? findRuntimeMatches(selected, inventory()!) : []; };
  const load = () => resolveLoadState(matches());
  const failure = () => { const value = load(); return value.kind === 'failed' ? value : null; };
  const update = () => resolveUpdateFlag(matches());
  const available = () => target()?.kind === 'package' && (update() !== 'none' || !!nativePluginRewrite(currentRegistry()));
  async function snapshot(check = false, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (!(operation.current() && current())) return;
    const next = await readNativePluginInventory(operation.request, directory, check);
    if ((operation.current() && current())) { inventory.set(next); state.ready.set(true); }
  }
  async function readRegistry(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    const selected = target();
    if (selected?.kind !== 'package' || !(operation.current() && current())) return;
    await registryState.perform(async (operation) => { const next = await readNativePluginRegistry(operation.request, selected.target, directory); if ((operation.current() && current()) && registryState.current()) registry.set(next); });
  }
  void state.perform((operation) => snapshot(undefined, operation));
  void readRegistry();
  state.observeOperation(operation => { if (operation) { void state.perform(lane => snapshot(false, lane), operation); void readRegistry(operation); } });
  registryState.observeOperation(operation => { if (operation) void readRegistry(); });
  return <SettingsGroup title={t('settings.plugins.page.header.entry')}>
    <SettingsFeedback state={state} retry={() => { void state.perform((operation) => snapshot(undefined, operation)); }} />
    <SettingsFeedback state={registryState} retry={() => { void readRegistry(); }} />
    <If when={!inventory() || !target()}><Text class="text-muted-foreground">{t('settings.plugins.status.unknown.description')}</Text></If>
    <If when={!!inventory() && !!target() && load().kind === 'active'}><Text class="text-foreground">{resolveEffectivePluginVersion(matches()) ? t('settings.plugins.status.loadedVersion', { version: resolveEffectivePluginVersion(matches())! }) : t('settings.plugins.status.loaded')}</Text></If>
    <If when={!!inventory() && !!target() && load().kind === 'notReported'}><Text class="text-muted-foreground">{t('settings.plugins.status.notReported.description')}</Text></If>
    <If when={!!failure()}>
      <Text class="text-destructive">{t('settings.plugins.status.failed.title')}</Text>
      <TextView document={{ blocks: [{ type: 'codeBlock', code: expanded() ? failure()?.error || '' : (failure()?.error || '').split('\n').slice(0, 2).join('\n') }] }} selectable class="text-sm text-foreground" />
      <If when={!!failure()?.ref}><Text class="text-muted-foreground">{t('settings.plugins.status.failed.ref', { ref: failure()?.ref || '' })}</Text></If>
      <If when={(failure()?.error || '').split('\n').length > 2}><Button class={settingsAction} onPress={() => expanded.set(!expanded())}><Text class="text-foreground">{expanded() ? t('settings.plugins.status.failed.collapse') : t('settings.plugins.status.failed.expand', { count: (failure()?.error || '').split('\n').length })}</Text></Button></If>
      <Button testID="plugin-copy-error" class={settingsAction} onPress={() => { const operation = state.operation(), error = failure()?.error; if (operation?.current() && error) void Clipboard.writeText(error).then(() => { if (operation.current()) state.notice.set(t('settings.plugins.status.failed.copied')); }, () => { if (operation.current()) state.error.set(t('settings.plugins.status.failed.copyFailed')); }); }}><Text class="text-foreground">{t('settings.plugins.status.failed.copy')}</Text></Button>
    </If>
    <View class="gap-2">
      <Button testID="plugin-runtime-refresh" class={settingsAction} disabled={state.busy()} onPress={() => { void state.perform((operation) => snapshot(undefined, operation)); }}><Text class="text-foreground">{t('sidebarFilesTree.actions.refreshTitle')}</Text></Button>
      <Button testID="plugin-reload" class={settingsAction} disabled={!current() || props.disabled || state.busy()} onPress={() => { if (props.disabled || !current()) return; void state.perform(async (operation) => { await reloadNativePlugins(operation.request, operation.current); if (!operation.current()) return; state.notice.set(t('settings.plugins.page.toast.reloaded')); await snapshot(undefined, operation); }); }}><Text class="text-foreground">{t('settings.plugins.page.action.reload')}</Text></Button>
      <If when={target()?.kind === 'package'}><Button testID="plugin-check-updates" class={settingsAction} disabled={props.disabled || state.busy() || registryState.busy()} onPress={() => { if (props.disabled || !current()) return; void state.perform(async (operation) => { await snapshot(true, operation); await readRegistry(operation); }); }}><Text class="text-foreground">{t('settings.plugins.sidebar.actions.refresh')}</Text></Button></If>
      <If when={available()}><Text class="text-muted-foreground">{update() === 'updating' ? t('settings.plugins.update.running') : text(currentRegistry()?.latestVersion) ? t('settings.plugins.update.available.toVersion', { version: text(currentRegistry()?.latestVersion) }) : t('settings.plugins.update.available.title')}</Text><Button testID="plugin-update" class={settingsAction} disabled={props.disabled || state.busy() || registryState.busy() || update() === 'updating'} onPress={() => { if (props.disabled || !current()) return; void state.perform(async (operation) => {
        const selected = target();
        if (!selected || !available()) return;
        const rewrite = nativePluginRewrite(currentRegistry());
        const result = await updateNativePlugin(operation.request, selected, text(props.item.id), currentRegistry(), directory, operation.current);
        if (!(operation.current() && current())) return;
        props.onUpdated(rewrite || undefined);
        if (rewrite) registry.set(null);
        if (result.warning) state.error.set(result.warning);
        else state.notice.set(t('settings.plugins.update.toast.done', { name: text(props.item.spec) }));
        await snapshot(undefined, operation);
        await readRegistry(operation);
      }); }}><Text class="text-foreground">{t('settings.plugins.update.action')}</Text></Button></If>
    </View>
  </SettingsGroup>;
}
