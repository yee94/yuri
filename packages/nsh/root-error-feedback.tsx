import { NativeErrorNotice } from './error-notice';
import { app, rootErrorActions, rootErrorFeedback } from './state';
import { t } from './i18n';

export const rootErrorVisible = () => {
  const failure = rootErrorFeedback();
  return !!app.error() && (!failure || failure.visible && failure.current());
};
export function NativeRootErrorFeedback(props: { suppressed?: boolean } = {}) {
  const failure = () => rootErrorFeedback();
  return <If when={!props.suppressed && rootErrorVisible()}>
    <NativeErrorNotice testID="root-error-feedback" message={failure()?.message ?? t('native.feedback.operation')} busy={failure()?.busy}
      onClose={() => { const value = failure(); if (value) rootErrorActions.dismiss(value.id); else app.error.set(''); }}
      onRetry={failure()?.retry ? () => { const value = failure(); if (value) void rootErrorActions.retry(value.id); } : undefined} />
  </If>;
}
