import { signal } from 'nsh';
import { nativeAppearance, refreshNativeAppearance, retryNativeAppearanceFonts } from './appearance';
import { t } from './i18n';
import { NativeErrorNotice } from './error-notice';

/** Only a safe local summary is rendered: raw HTTP errors, URLs and Host settings never enter this surface. */
export function NativeAppearanceFeedback(props: { suppressed?: boolean } = {}) {
  const retrying = signal(false);
  const dismissed = signal<{ snapshot: ReturnType<typeof nativeAppearance.current>; error: string; issue: string | null } | null>(null);
  const fontIssue = () => nativeAppearance.current()?.fontStatus === 'failed' ? 'failed'
    : nativeAppearance.current()?.fontStatus !== 'loading' && !!nativeAppearance.current()?.unsupportedFonts.length ? 'unsupported' : null;
  const hidden = () => dismissed()?.snapshot === nativeAppearance.current() && dismissed()?.error === nativeAppearance.error() && dismissed()?.issue === fontIssue();
  return <If when={!props.suppressed && (!!nativeAppearance.error() || !!fontIssue()) && !hidden()}>
    <NativeErrorNotice testID="appearance-feedback" severity={!nativeAppearance.error() && fontIssue() === 'unsupported' ? 'warning' : 'error'} message={t('settings.page.appearance.title') + ' · ' + (nativeAppearance.error() ? t('chat.chatInput.toast.reloadFailed') : t(fontIssue() === 'failed' ? 'settings.appearance.fontLoadFailed' : 'settings.appearance.fontUnsupported'))}
      busy={retrying() || nativeAppearance.saving()} onClose={() => dismissed.set({ snapshot: nativeAppearance.current(), error: nativeAppearance.error(), issue: fontIssue() })} onRetry={() => {
        if (retrying()) return;
        retrying.set(true);
        void (nativeAppearance.error() || !fontIssue() ? refreshNativeAppearance() : retryNativeAppearanceFonts()).finally(() => retrying.set(false));
      }} />
  </If>;
}
