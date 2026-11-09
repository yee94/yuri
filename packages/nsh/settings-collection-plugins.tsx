import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { text, type Row } from './model';
import { SettingsFeedback, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { createCollectionPluginUpdates } from './settings-collection-plugins-core';
import { findRuntimeMatches, nativePluginTarget, readNativePluginInventory, resolveLoadState, resolveEffectivePluginVersion, type PluginRuntimeInfo } from './settings-plugin-runtime-core';

export function SettingsCollectionPlugins(props: { rows: Row[]; directory?: string; current: () => boolean; onUpdated: () => void; onOpen: (item: Row) => void }) {
  const state = settingsPageLifetime(props.current), inventory = signal<PluginRuntimeInfo[] | null>(null), revision = signal(0);
  let batch: ReturnType<typeof createCollectionPluginUpdates> | undefined;
  const load = async (operation: SettingsOperation | null = state.operation()) => {
    if (!operation?.current()) return;
    await state.perform(async lane => { if (batch) { await batch.reconcile(lane); if (lane.current()) revision.set(revision() + 1); } const next = await readNativePluginInventory(lane.request, props.directory); if (lane.current()) inventory.set(next); }, operation);
  };
  void load(); state.observeOperation(operation => { if (operation) void load(operation); });
  const matches = (item: Row) => { const target = nativePluginTarget(item); return target && inventory() ? findRuntimeMatches(target, inventory()!) : []; };
  const results = () => { revision(); return batch?.results() || []; };
  return <View class="gap-2"><SettingsFeedback state={state} retry={() => { void load(); }} />
    <If when={results().some(result => result.state === 'unknown')}><Button class={settingsAction} disabled={state.busy()} onPress={() => { void load(); }}><Text class="text-foreground">{t('sidebarFilesTree.actions.refreshTitle')}</Text></Button></If>
    <Each of={props.rows}>{item => <Button class="min-h-12 py-3 gap-1 border-b border-border" onPress={() => props.onOpen(item())}><Text class="text-sm text-foreground">{text(item().spec) || text(item().filename)}</Text><Text class="text-xs text-muted-foreground">{!inventory() ? t('settings.plugins.status.unknown.description') : resolveLoadState(matches(item())).kind === 'active' ? resolveEffectivePluginVersion(matches(item())) ? t('settings.plugins.status.loadedVersion', { version: resolveEffectivePluginVersion(matches(item()))! }) : t('settings.plugins.status.loaded') : resolveLoadState(matches(item())).kind === 'failed' ? t('settings.plugins.status.failed.title') : t('settings.plugins.status.notReported.description')}</Text></Button>}</Each>
    <Button class={settingsAction} disabled={state.busy()} onPress={() => { void state.perform(async lane => {
      if (!batch) batch = createCollectionPluginUpdates(lane.request, props.current, props.directory);
      await batch.update(props.rows, lane);
      if (!lane.current()) return;
      revision.set(revision() + 1); props.onUpdated();
      const next = await readNativePluginInventory(lane.request, props.directory); if (lane.current()) inventory.set(next);
    }); }}><Text class="text-foreground">{t('settings.plugins.sidebar.actions.updateAll')}</Text></Button>
    <Each of={results()}>{result => <View><Text class={result().state === 'updated' ? 'text-muted-foreground' : 'text-destructive'}>{result().state === 'updated' ? t('settings.plugins.update.toast.done', { name: result().id }) : `${result().id}: ${t('settings.plugins.status.unknown.description')}`}</Text><If when={!!result().message}><Text class="text-destructive">{result().message}</Text></If></View>}</Each>
  </View>;
}
