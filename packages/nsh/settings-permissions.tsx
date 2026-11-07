import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { text, type Row } from './model';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { deleteNativeSavedPermission, readNativeSavedPermissions, type NativeSavedPermissionSnapshot } from './settings-saved-permissions-core';

/** Rule order is authoritative: the last matching action/resource rule wins. */
export function SettingsPermissions(props: { rules: Row[]; disabled?: boolean; onChange: (rules: Row[]) => void }) {
  function update(index: number, patch: Row) { props.onChange(props.rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule)); }
  return <SettingsGroup title={t('settings.agents.page.section.toolPermissions')}>
    <Text class="text-xs text-muted-foreground">{t('settings.agents.page.permissions.lastMatchHint')}</Text>
    <Each of={props.rules}>{(rule, index) => <View class="gap-2 py-3 border-b border-border">
      <SettingsInput title={t('settings.agents.page.permissions.permissionPlaceholder')} value={text(rule().action)} disabled={props.disabled} onChange={next => update(index(), { action: next })} />
      <SettingsInput title={t('settings.agents.page.permissions.pattern')} value={text(rule().resource)} disabled={props.disabled} onChange={next => update(index(), { resource: next })} />
      <SettingsChoice title={t('settings.agents.page.section.toolPermissions')} value={text(rule().effect)} disabled={props.disabled} items={(['allow', 'ask', 'deny'] as const).map(value => ({ value, title: t(`settings.common.permission.${value}`) }))} onChange={next => update(index(), { effect: next })} />
      <Button class={settingsAction} disabled={props.disabled} onPress={() => props.onChange(props.rules.filter((_, position) => position !== index()))}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button>
    </View>}</Each>
    <Button class={settingsAction} disabled={props.disabled} onPress={() => props.onChange([...props.rules, { action: '', resource: '*', effect: 'ask' }])}><Text class="text-foreground">{t('settings.agents.page.permissions.addCustomRule')}</Text></Button>
  </SettingsGroup>;
}

export function SettingsSavedPermissions(props: { directory?: string }) {
  const state = settingsPageLifetime(), snapshot = signal<NativeSavedPermissionSnapshot | null>(null);

  const directory = props.directory?.trim() || '';
  const current = () => state.current() && (props.directory?.trim() || '') === directory;
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      try {
        const next = await readNativeSavedPermissions(operation.request, directory, operation.current);
        if ((operation.current() && current())) { snapshot.set(next); state.ready.set(true); }
      } catch { throw new Error(t('settings.permissions.saved.loadFailed')); }
    }, operation);
  }
  if (directory) void load();
  state.observeOperation(operation => { if (operation && directory) void load(operation); });
  return <If when={!!directory && current()}><SettingsGroup title={t('settings.permissions.saved.title')}>
    <SettingsFeedback state={state} retry={() => { void load(); }} />
    <Button testID="saved-permissions-refresh" class={settingsAction} disabled={state.busy()} onPress={() => { void load(); }}><Text class="text-foreground">{t('sidebarFilesTree.actions.refreshTitle')}</Text></Button>
    <If when={state.ready() && !snapshot()?.items.length}><Text class="text-muted-foreground">{t('settings.permissions.saved.empty')}</Text></If>
    <Each of={snapshot()?.items || []}>{item => <View class="gap-2 py-3 border-b border-border">
      <Text class="text-foreground">{item().action}</Text><Text class="text-sm text-muted-foreground">{item().resource}</Text>
      <Button testID={`saved-permission-delete-${item().id}`} class={settingsAction} disabled={state.busy() || !!state.error() || !state.ready()} onPress={() => { void state.perform(async (operation) => {
        const captured = snapshot();
        if (!captured) return;
        try { const next = await deleteNativeSavedPermission(operation.request, captured, item().id, operation.current); if ((operation.current() && current())) snapshot.set(next); }
        catch { throw new Error(t('settings.permissions.saved.deleteFailed')); }
      }); }}><Text class="text-destructive">{t('settings.permissions.saved.delete')}</Text></Button>
    </View>}</Each>
  </SettingsGroup></If>;
}
