import { effect, lifecycle, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { native } from './runtime';
import { SettingsChoice, settingsAction, type SettingsOperation } from './settings-controls';
import { parseNativeVoiceCatalog, readSayVoiceCatalog } from './settings-voice-catalog-core';

export function SettingsVoiceCatalog(props: { provider: () => unknown; value: () => string; active: () => boolean; operation: () => SettingsOperation | null; disabled: () => boolean; onChange: (key: 'sayVoice' | 'browserVoice', value: string) => void }) {
  const items = signal<{ value: string; title: string }[]>([]), failed = signal(false), busy = signal(false);
  let generation = 0;
  async function load() {
    const provider = props.provider(), operation = props.operation(), ticket = ++generation;
    items.set([]); failed.set(false); busy.set(false);
    if (!props.active() || lifecycle() !== 'active' || !operation?.current() || !['say', 'browser'].includes(String(provider))) return;
    const current = () => ticket === generation && props.active() && lifecycle() === 'active' && props.provider() === provider && operation.current();
    busy.set(true);
    try {
      let rows: { value: string; title: string }[];
      if (provider === 'say') {
        const result = await readSayVoiceCatalog(operation.request);
        rows = result.available ? result.voices.map(voice => ({ value: voice.name, title: `${voice.name} · ${voice.locale}` })) : [];
      } else {
        const result = parseNativeVoiceCatalog(await native('speech.voices', { expectedHost: operation.scope }));
        // Duplicate native names cannot round-trip the Web name setting safely.
        const counts = new Map<string, number>();
        for (const voice of result.voices) counts.set(voice.name, (counts.get(voice.name) ?? 0) + 1);
        rows = result.voices.length ? [{ value: '', title: t('settings.voice.page.field.auto') }, ...result.voices.filter(voice => counts.get(voice.name) === 1).map(voice => ({ value: voice.name, title: `${voice.name} · ${voice.language}` }))] : [];
      }
      if (current()) items.set(rows);
    } catch { if (current()) failed.set(true); }
    finally { if (current()) busy.set(false); }
  }
  effect(() => { props.provider(); props.active(); props.operation(); lifecycle(); untracked(() => { void load(); }); });
  return <View class="gap-2"><If when={items().length > 0}><SettingsChoice testID="settings-voice-catalog" title={t('settings.voice.page.field.voice')} value={props.value()} items={items()} disabled={props.disabled() || busy()} onChange={value => { if (items().some(item => item.value === value)) props.onChange(props.provider() === 'say' ? 'sayVoice' : 'browserVoice', value); }} /></If><If when={failed()}><Text class="text-destructive">{t('common.unavailable')}</Text><Button testID="settings-voice-catalog-retry" class={settingsAction} disabled={busy() || !props.active()} onPress={() => { void load(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If></View>;
}
