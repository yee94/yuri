import { Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import { text, type Row } from './model';
import { SettingsFeedback, SettingsInput, settingsAction, settingsPageLifetime } from './settings-controls';
import { settingsObject, settingsRows } from './settings-protocol';

export function SettingsCollectionDirectory(props: { directory?: string; disabled: boolean; current: () => boolean; onChange: (directory: string | undefined) => void }) {
  const state = settingsPageLifetime(props.current), open = signal(false), rows = signal<Row[]>([]), search = signal('');
  const load = () => state.perform(async lane => { const settings = settingsObject(await lane.request('/api/config/settings')); const next = settingsRows(settings.projects); if (lane.current()) { rows.set(next); state.ready.set(true); } });
  const visible = () => rows().filter(row => typeof row.path === 'string' && row.path && `${text(row.label)} ${text(row.name)} ${text(row.path)}`.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase()));
  return <View><Button class={settingsAction} disabled={props.disabled} accessibilityLabel={t('settings.shared.projectSelector.switchProjectAria')} onPress={() => { if (!props.current()) return; search.set(''); open.set(true); void load(); }}><Text class="text-foreground">{props.directory || t('settings.common.scope.global')}</Text></Button>
    <NativeSheet open={open()} closeOnSwipe onOpenChange={event => open.set(event.open)} popupClass="bg-background"><Scroll class="flex-1" contentClass="p-5 gap-3" contentStyle={nativeDensity().pages.sheetPicker}><SettingsFeedback state={state} retry={() => { void load(); }} /><SettingsInput title={t('settings.shared.projectSelector.switchProjectTitle')} value={search()} onChange={next => search.set(next)} /><Button class={settingsAction} onPress={() => { if (!props.current()) return; open.set(false); props.onChange(undefined); }}><Text class="text-foreground">{t('settings.common.scope.global')}</Text></Button><Each of={visible()}>{project => <Button class={settingsAction} onPress={() => { if (!props.current()) return; const directory = text(project().path); open.set(false); props.onChange(directory); }}><Text class="text-foreground">{text(project().label) || text(project().name) || text(project().path)}</Text><Text class="text-xs text-muted-foreground">{text(project().path)}</Text></Button>}</Each><Button class={settingsAction} onPress={() => open.set(false)}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button></Scroll></NativeSheet>
  </View>;
}
