import React from 'react';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { FilePreviewError } from '@/components/ui/FilePreviewError';

type Props<Network> = {
  open(signal: AbortSignal, onFailure: () => void): Promise<Network>;
  children(network: Network): React.ReactNode;
};

/** Remove executing content before releasing its network owner. Platforms only
 * supply acquisition; generation fencing, failure, retry and UI stay shared.
 */
export function HtmlNetworkBoundary<Network>({ open, children }: Props<Network>) {
  const { t } = useI18n();
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const [result, setResult] = React.useState<{ generation: number; attempt: number; open: Props<Network>['open']; network?: Network; failed?: boolean }>();
  const current = result?.generation === generation && result.attempt === attempt && result.open === open ? result : undefined;
  const failed = current?.failed === true;
  React.useEffect(() => {
    if (failed) return;
    const controller = new AbortController();
    let lost = false;
    const fail = () => {
      lost = true;
      if (!controller.signal.aborted) setResult({ generation, attempt, open, failed: true });
    };
    void open(controller.signal, fail).then(network => {
      if (!controller.signal.aborted && !lost) setResult({ generation, attempt, open, network });
    }).catch(fail);
    return () => controller.abort();
  }, [generation, attempt, failed, open]);
  if (failed) return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
    <FilePreviewError message={t('contextPanel.preview.proxyError')} />
    <Button size="sm" onClick={retry}>{t('contextPanel.preview.actions.retry')}</Button>
  </div>;
  if (!current || current.network === undefined) return <div className="flex h-full items-center justify-center text-muted-foreground">{t('contextPanel.preview.loading')}</div>;
  return children(current.network);
}
