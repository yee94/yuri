import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { nativeAppearance, refreshNativeAppearance } from './appearance';
import { t } from './i18n';

/** Only a safe local summary is rendered: raw HTTP errors, URLs and Host settings never enter this surface. */
export function NativeAppearanceFeedback() {
  const retrying = signal(false);
  return <If when={!!nativeAppearance.error()}>
    <View testID="appearance-feedback" class="pt-[env(safe-area-inset-top)] px-4 py-2 bg-card flex-row items-center gap-3">
      <Text class="flex-1 text-sm text-destructive">{t('settings.page.appearance.title')} · {t('chat.chatInput.toast.reloadFailed')}</Text>
      <Button testID="appearance-retry" class="min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent items-center justify-center disabled:opacity-40" disabled={retrying() || nativeAppearance.saving()} onPress={() => {
        if (retrying()) return;
        retrying.set(true);
        void refreshNativeAppearance().finally(() => retrying.set(false));
      }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button>
    </View>
  </If>;
}
