import { Scroll, signal, Text, View } from 'nsh';
import { Button, Editor } from 'nsh/base';
import { t } from './i18n';
import { nativeChatTextStyle } from './appearance';
import { SettingsGroup, settingsAction, settingsPageLifetime } from './settings-controls';
import { publishSettingsEditor } from './desktop-settings-publisher';
import { createGlobalConfigEditor } from './settings-global-config-core';
import { SettingsTarget } from './settings-target';

export function SettingsGlobalConfig(props: { active?: boolean; target?: string }) {
  const lifetime = settingsPageLifetime(() => props.active !== false), initial = lifetime.operation();
  const editor = createGlobalConfigEditor(initial?.request ?? (async () => { throw new Error('Runtime changed'); }), initial?.current ?? (() => false), next => state.set(next));
  const state = signal(editor.state());
  const navigation = publishSettingsEditor({ current: lifetime.current, scope: lifetime.operation,
    pending: () => state().busy || state().unconfirmed, dirty: editor.dirty, stamp: () => [state().draft],
  });
  lifetime.observeOperation(operation => { editor.replaceLane(operation); if (operation) void editor.load(); });
  void editor.load();
  async function reload() {
    if (state().unconfirmed) { await editor.load(); return; }
    if (await navigation.requestLeave()) await editor.load(true);
  }
  return <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10">
    <SettingsTarget id="global-config.editor" target={props.target}><SettingsGroup title={t('settings.globalConfig.title')}>
      <Text class="text-sm text-muted-foreground">{t('settings.globalConfig.description')}</Text>
      <If when={state().busy}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!state().error}><Text testID="global-config-error" class="text-sm text-destructive">{t(state().error === 'save' ? 'settings.globalConfig.toast.saveFailed' : 'settings.globalConfig.toast.loadFailed')}</Text></If>
      <If when={state().saved}><Text class="text-sm text-muted-foreground">{t('settings.globalConfig.toast.saved')}</Text></If>
      <View class="flex-row flex-wrap gap-2">
        <Button testID="global-config-reload" class={settingsAction} disabled={state().busy || !lifetime.current()} onPress={() => { void reload(); }}><Text class="text-foreground">{t('settings.globalConfig.actions.reload')}</Text></Button>
        <Button testID="global-config-save" class={settingsAction} disabled={state().busy || !lifetime.current() || !editor.dirty() && !state().unconfirmed} onPress={() => { void editor.save(); }}><Text class="text-foreground">{t(state().unconfirmed ? 'settings.voice.volcengine.retry' : 'settings.common.actions.saveChanges')}</Text></Button>
      </View>
      <If when={!!state().file}>
        <Text class="text-xs text-muted-foreground">{state().file?.fileName}</Text>
        <Editor testID="global-config-editor" value={state().draft} language="jsonc" lineNumbers minRows={24} class="bg-background text-foreground"
          readOnly={state().busy || state().unconfirmed || !lifetime.current()} fontFamily={nativeChatTextStyle('code').fontFamily} fontSize={nativeChatTextStyle('code').fontSize} lineHeight={(nativeChatTextStyle('code').fontSize ?? 13) * 1.625}
          accessibilityLabel={t('settings.globalConfig.title')} onChange={event => editor.edit(event.value)} />
      </If>
    </SettingsGroup></SettingsTarget>
  </Scroll>;
}
