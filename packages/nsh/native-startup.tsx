import { signal, Text, View } from 'nsh';
import { YuriNativeApp } from './application';
import { NativeAuthorizationCacheCleanupRoot } from './newauthorization-cache-cleanup-root';
import { retireHistoryAuthorization } from './state';
import { t } from './i18n';
import { NativeErrorNotice, NativeFeedbackLayer } from './error-notice';

/** The production entry cannot hydrate history until native retirement receipts are swept. */
export function NativeStartup() {
  const ready = signal(false), status = signal({ busy: true, failed: false });
  const dismissed = signal(false);
  let retry: (() => Promise<void>) | null = null;
  function StartupFeedback() {
    return <If when={status().failed && !dismissed()}><NativeErrorNotice testID="authorization-cache-feedback" message={t('native.feedback.operation')} busy={status().busy} onRetry={() => { if (retry && !status().busy) void retry(); }} onClose={() => dismissed.set(true)} /></If>;
  }
  return <View class="flex-1 bg-background">
    <NativeAuthorizationCacheCleanupRoot retire={retireHistoryAuthorization} onReady={() => ready.set(true)}
      onState={next => { status.set(next); dismissed.set(false); }} onRetryAvailable={next => { retry = next; }} />
    <If when={ready()}><YuriNativeApp startupFeedback={<StartupFeedback />} startupFeedbackVisible={status().failed && !dismissed()} /></If>
    <If when={!ready() && !dismissed()}><NativeFeedbackLayer>
      <StartupFeedback />
      <If when={!status().failed}><Text class="text-muted-foreground">{t('common.loading')}</Text></If>
    </NativeFeedbackLayer></If>
  </View>;
}
