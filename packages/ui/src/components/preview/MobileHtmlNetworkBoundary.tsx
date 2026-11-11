import React from 'react';
import { isCapacitorApp } from '@/lib/platform';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { acquireMobileHtmlNetwork } from '@/lib/preview/mobile-html-network';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { FilePreviewError } from '@/components/ui/FilePreviewError';

type Network = { hostOrigin?: string };
type Props = {
  children: (network?: Network) => React.ReactNode;
  /** Built-in HTML needs the Host HTTP origin; plugin views only need egress routed. */
  connect?: boolean;
};

function NativeBoundary({ children, connect = true }: Props) {
  const { t } = useI18n();
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const [result, setResult] = React.useState<{ generation: number; attempt: number; network?: Network; failed?: boolean }>();
  const current = result?.generation === generation && result.attempt === attempt ? result : undefined;
  const failed = current?.failed === true;
  React.useEffect(() => {
    if (failed) return;
    const controller = new AbortController();
    let lost = false;
    const fail = () => {
      lost = true;
      if (!controller.signal.aborted) setResult({ generation, attempt, failed: true });
    };
    // HTML needs the Host's HTTP origin from the channel handshake, so it connects now.
    void acquireMobileHtmlNetwork(controller.signal, connect ? fail : () => {})
      .then(lease => connect ? lease.connect(controller.signal) : {})
      .then(network => {
        if (!controller.signal.aborted && !lost) setResult({ generation, attempt, network });
      }).catch(fail);
    // Passive cleanup runs after the iframe/HTML descendants have been removed.
    return () => controller.abort();
  }, [generation, attempt, failed, connect]);
  if (failed) return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
    <FilePreviewError message={t('contextPanel.preview.proxyError')} />
    <Button size="sm" onClick={retry}>{t('contextPanel.preview.actions.retry')}</Button>
  </div>;
  if (!current?.network) return <div className="flex h-full items-center justify-center text-muted-foreground">{t('contextPanel.preview.loading')}</div>;
  return children(current.network);
}

/**
 * Built-in HTML and plugin views route through Relay only while mounted; the rest of
 * the application keeps its original network path.
 */
export function MobileHtmlNetworkBoundary({ children, connect }: Props) {
  return isCapacitorApp() ? <NativeBoundary connect={connect}>{children}</NativeBoundary> : children();
}
