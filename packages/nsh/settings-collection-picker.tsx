import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { FeaturesModelPicker } from './features-model-picker';
import { parseModelIdentifier } from '../ui/src/lib/modelIdentifier';
import { t } from './i18n';
import { text, type Row } from './model';
import { SettingsChoice, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { readSettingsCollection, scopedSettingsPath, settingsObject, settingsRows } from './settings-protocol';

/** The existing composable picker owns preferences/presentation, never feature editor state. */
export function SettingsCollectionPicker(props: { value: string; directory?: string; disabled: boolean; agent?: boolean; current: () => boolean; onChange: (value: string) => void }) {
  const state = settingsPageLifetime(props.current), providers = signal<Row[]>([]), agents = signal<Row[]>([]), partial = signal(false);
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async lane => {
      if (props.agent) { const next = await readSettingsCollection(lane.request, 'agents', props.directory); if (lane.current()) agents.set(next); }
      else {
        const next = settingsObject(await lane.request(scopedSettingsPath('/api/config/catalog/providers', props.directory)));
        if (next.schemaVersion !== 1) throw new Error(t('assistants.state.invalidConfiguration'));
        const rows = settingsRows(next.providers);
        if (lane.current()) { providers.set(rows); partial.set(next.partial === true || next.complete === false); }
      }
      if (lane.current()) state.ready.set(true);
    }, operation);
  }
  void load(); state.observeOperation(operation => { if (operation) void load(operation); });
  const selected = () => { const value = parseModelIdentifier(props.value); return { providerID: value?.providerId || '', modelID: value?.modelId || '', variant: value?.variant || '' }; };
  return <View class="gap-2">
    <If when={props.agent}><SettingsChoice title={t('settings.commands.page.field.overrideAgent')} value={props.value} disabled={props.disabled || !state.ready()} items={[{ value: '', title: t('settings.agents.modelSelector.notSelected') }, ...agents().map(row => ({ value: text(row.name), title: text(row.name) }))]} onChange={props.onChange} /><If when={!!state.error()}><Text class="text-destructive">{state.error()}</Text><Button class={settingsAction} onPress={() => { void load(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If></If>
    <If when={!props.agent}><FeaturesModelPicker providers={providers()} selected={selected()} disabled={props.disabled} loading={state.busy()} error={state.error()} partial={partial()} current={props.current} request={(...args) => { const lane = state.operation(); if (!lane?.current()) return Promise.reject(new Error('Runtime changed')); return lane.request(...args); }} reload={() => { void load(); }} onChange={next => props.onChange(next.providerID && next.modelID ? `${next.providerID}/${next.modelID}${next.variant ? `#${next.variant}` : ''}` : '')} /></If>
  </View>;
}
