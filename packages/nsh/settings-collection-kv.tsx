import { Clipboard, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import type { Row } from './model';
import { mergeCollectionEnv } from './settings-collection-operations';
import { SettingsInput, settingsAction } from './settings-controls';

/** Secrets stay in this ephemeral Sheet draft. Cancel never publishes to the parent. */
export function SettingsCollectionKV(props: { value: Row; headers?: boolean; disabled: boolean; current: () => boolean; onChange: (value: Row) => void }) {
  const open = signal(false), entries = signal<{ id: number; key: string; value: string; revealed: boolean }[]>([]), error = signal('');
  let serial = 0, generation = 0;
  const seed = (value: Row) => Object.entries(value).map(([key, value]) => ({ id: ++serial, key, value: String(value), revealed: false }));
  const close = () => { generation++; open.set(false); };
  const set = (id: number, update: Partial<{ key: string; value: string; revealed: boolean }>) => entries.set(entries().map(entry => entry.id === id ? { ...entry, ...update } : entry));
  const snapshot = () => {
    const keys = entries().map(entry => entry.key.trim());
    if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error(t('assistants.state.invalidConfiguration'));
    return Object.fromEntries(entries().map(entry => [entry.key.trim(), entry.value]));
  };
  return <View class="gap-2">
    <Button class={settingsAction} disabled={props.disabled} onPress={() => { if (!props.current()) return; entries.set(seed(props.value)); error.set(''); generation++; open.set(true); }}><Text class="text-foreground">{t(props.headers ? 'settings.mcp.page.advanced.requestHeaders' : 'settings.mcp.page.env.title')}</Text></Button>
    <NativeSheet open={open()} closeOnSwipe closeOnBackdropPress closeOnEscape onOpenChange={event => { if (!event.open) close(); }} onClose={() => { entries.set([]); error.set(''); }} popupClass="bg-background" detents={[.72, .98]}>
      <Scroll class="flex-1" contentClass="p-5 gap-4 pb-10" contentStyle={nativeDensity().pages.sheetEditor}>
        <If when={!!error()}><Text class="text-destructive">{error()}</Text></If>
        <Each of={entries().map(entry => entry.id)}>{id => {
          const entry = () => entries().find(entry => entry.id === id()) ?? { id: id(), key: '', value: '', revealed: false };
          return <View class="gap-2">
          <SettingsInput title={t('settings.mcp.page.env.key')} value={entry().key} onChange={value => set(entry().id, { key: value })} />
          <SettingsInput title={t('settings.mcp.page.env.value')} value={entry().value} masked={!entry().revealed} onChange={value => set(entry().id, { value })} />
          <View class="flex-row gap-2"><Button class={settingsAction} onPress={() => set(entry().id, { revealed: !entry().revealed })}><Text class="text-foreground">{t(entry().revealed ? 'settings.mcp.page.env.hide' : 'settings.mcp.page.env.show')}</Text></Button>
            <Button class={settingsAction} onPress={() => entries.set(entries().filter(item => item.id !== entry().id))}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button></View>
        </View>; }}</Each>
        <Button class={settingsAction} onPress={() => entries.set([...entries(), { id: ++serial, key: '', value: '', revealed: false }])}><Text class="text-foreground">{t('settings.mcp.page.env.addVariable')}</Text></Button>
        <Button class={settingsAction} onPress={() => { const captured = generation; void Clipboard.readText().then(input => { if (captured !== generation || !open() || !props.current()) return; try { entries.set(seed(mergeCollectionEnv(snapshot(), input))); error.set(''); } catch { error.set(t('assistants.state.invalidConfiguration')); } }, () => { if (captured === generation && open()) error.set(t('assistants.state.invalidConfiguration')); }); }}><Text class="text-foreground">{t(props.headers ? 'settings.mcp.page.advanced.pasteHeaders' : 'settings.mcp.page.env.pasteEnv')}</Text></Button>
        <Button class={settingsAction} disabled={props.disabled} onPress={() => { if (!props.current() || props.disabled) return; try { props.onChange(snapshot()); close(); } catch { error.set(t('assistants.state.invalidConfiguration')); } }}><Text class="text-foreground">{t('settings.common.actions.saveChanges')}</Text></Button>
        <Button class={settingsAction} onPress={close}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>
      </Scroll>
    </NativeSheet>
  </View>;
}
