import { signal, Text } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { record, text, type Row } from './model';
import { SettingsFeedback, SettingsGroup, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { SettingsIntegration } from './settings-integration';
import { settingsObject, settingsRows } from './settings-protocol';

export function SettingsMcpLive(props: { name: string; directory?: string; disabled: boolean }) {
  const state = settingsPageLifetime(), server = signal<Row>({});

  const location = props.directory ? `?location%5Bdirectory%5D=${encodeURIComponent(props.directory)}` : '';
  async function snapshot(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    const body = settingsObject(await operation.request(`/api/mcp${location}`));
    const current = settingsRows(body.data).find(item => item.name === props.name);
    if (operation.current()) { server.set(current || {}); state.ready.set(true); }
  }
  void state.perform(snapshot);
  state.observeOperation(operation => { if (operation) void state.perform(snapshot, operation); });
  return <SettingsGroup title={t('settings.mcp.page.server.title')}>
    <SettingsFeedback state={state} retry={() => { void state.perform(snapshot); }} />
    <Text class="text-sm text-muted-foreground">{text(record(server().status).status) || text(server().status)}</Text>
    <Each of={['connect', 'disconnect'] as const}>{action => <Button class={settingsAction} disabled={props.disabled || state.busy() || !state.ready()} onPress={() => { void state.perform(async operation => { await operation.transaction(`/api/experimental/mcp/${encodeURIComponent(props.name)}/${action()}${location}`, 'POST'); await snapshot(operation); }); }}><Text class="text-foreground">{t(action() === 'connect' ? 'settings.mcp.page.actions.connect' : 'settings.mcp.page.actions.disconnect')}</Text></Button>}</Each>
    <If when={!!server().integrationID}><SettingsIntegration integrationID={text(server().integrationID)} directory={props.directory} disabled={props.disabled} onSaved={() => { void state.perform(snapshot); }} /></If>
  </SettingsGroup>;
}
