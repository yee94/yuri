import { Clipboard, keyboardFrame, safeArea, Scroll, signal, Text, windowSize } from 'nsh';
import { Button } from 'nsh/base';
import { nativeDensity } from './appearance';
import { NativeSheet as Sheet } from './native-sheet';
import { t } from './i18n';
import type { Row } from './model';
import { nativeMcpImport } from './settings-collections-core';
import { SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime } from './settings-controls';

/** Import owns only a disposable draft. Save/connect remain with their existing owners. */
export function SettingsMcpImport(props: { name: string; disabled: boolean; onOpenChange: (open: boolean) => void; onImport: (name: string, fields: Row) => void }) {
  const state = settingsPageLifetime(), open = signal(false), source = signal(''), error = signal('');
  let revision = 0;
  function close() { revision++; open.set(false); source.set(''); error.set(''); props.onOpenChange(false); }
  function begin() { if (props.disabled || !state.current()) return; revision++; source.set(''); error.set(''); open.set(true); props.onOpenChange(true); }
  async function paste() {
    const operation = state.operation();
    if (!operation?.current()) return;
    const captured = revision;
    try { const value = await Clipboard.readText(); if (operation.current() && open() && revision === captured) { source.set(value); error.set(''); } }
    catch { if (operation.current() && open() && revision === captured) error.set(t('settings.mcp.page.toast.clipboardReadFailed')); }
  }
  return <>
    <Button testID="mcp-import-open" class={settingsAction} disabled={props.disabled} onPress={begin}><Text class="text-foreground">{t('settings.mcp.page.server.importJson')}</Text></Button>
    <Sheet open={open()} closeOnSwipe closeOnBackdropPress closeOnEscape onOpenChange={event => { if (!event.open && state.current()) close(); }} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: Math.max(0, Math.min(windowSize().height * 0.85, windowSize().height - safeArea().top - keyboardFrame().height - 12)), marginBottom: keyboardFrame().height }} backdropClass="bg-background/50">
      <Scroll testID="mcp-import-sheet" class="flex-1" contentClass="p-5 gap-4 pb-10" contentStyle={nativeDensity().pages.sheetEditor}><If when={open()}><SettingsGroup title={t('settings.mcp.page.importDialog.title')}>
        <Text class="text-sm text-muted-foreground">{t('settings.mcp.page.importDialog.description')}</Text>
        <SettingsInput testID="mcp-import-source" title={t('settings.mcp.page.importDialog.title')} multiline value={source()} disabled={props.disabled} onChange={next => { revision++; source.set(next); error.set(''); }} />
        <If when={!!error()}><Text class="text-destructive">{t('settings.nsh.collections.importInvalid', { reason: error() })}</Text></If>
        <Button testID="mcp-import-paste" class={settingsAction} disabled={props.disabled} onPress={() => { void paste(); }}><Text class="text-foreground">{t('settings.mcp.page.importDialog.pasteFromClipboard')}</Text></Button>
        <Button testID="mcp-import-apply" class={settingsAction} disabled={props.disabled} onPress={() => {
          if (props.disabled || !state.current()) return;
          const outcome = nativeMcpImport(source(), props.name, true);
          if (!outcome.ok) { error.set(outcome.error); return; }
          props.onImport(outcome.name, outcome.fields); close();
        }}><Text class="text-foreground">{t('settings.mcp.page.server.importJson')}</Text></Button>
        <Button testID="mcp-import-cancel" class={settingsAction} onPress={close}><Text class="text-foreground">{t('settings.plugins.dialog.add.action.cancel')}</Text></Button>
      </SettingsGroup></If></Scroll>
    </Sheet>
  </>;
}
