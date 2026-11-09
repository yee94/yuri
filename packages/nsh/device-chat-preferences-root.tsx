import { cleanup, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { deviceChatPreferenceStore } from './settings-preferences-device';

/** Device authority is loaded once per root, independently of Host connection changes. */
export function NativeDeviceChatPreferences() {
  const failed = signal(false), loading = signal(false);
  let alive = true;
  cleanup(() => { alive = false; });
  async function load() {
    if (!alive || loading()) return;
    loading.set(true);
    try {
      await deviceChatPreferenceStore.load();
      if (alive) failed.set(false);
    } catch {
      if (alive) failed.set(true);
    } finally {
      if (alive) loading.set(false);
    }
  }
  void load();
  return <If when={failed()}><View testID="device-chat-preferences-error" class="pt-[env(safe-area-inset-top)] px-4 py-2 bg-card flex-row items-center gap-3">
    <Text class="flex-1 text-sm text-destructive">{t('settings.page.chat.title')} · {t('chat.chatInput.toast.reloadFailed')}</Text>
    <Button testID="device-chat-preferences-retry" class="min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent items-center justify-center disabled:opacity-40" disabled={loading()} onPress={() => { void load(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button>
  </View></If>;
}
