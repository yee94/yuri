import React from 'react';
import { useEventListener } from '@reactuses/core';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { FilePreviewError } from '@/components/ui/FilePreviewError';
import { Button } from '@/components/ui/button';
import { MobileHtmlNetworkBoundary } from '@/components/preview/MobileHtmlNetworkBoundary';
import { resolveMobileHtmlUrl } from '@/lib/preview/mobile-html-source';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { acquireRuntimeUrlAuthToken, subscribeRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { isLoopbackHttpUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { useMobileHtmlPreviewStore } from './useMobileHtmlPreviewStore';

function PreviewFrame({ url, hostOrigin }: { url: string; hostOrigin?: string }) {
  const { t } = useI18n();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const [result, setResult] = React.useState<{ url: string; hostOrigin?: string; attempt: number; src?: string; error?: boolean }>();
  React.useEffect(() => {
    const controller = new AbortController();
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const resolve = async () => {
      const current = ++revision;
      clearTimeout(renewal);
      try {
        const source = await resolveMobileHtmlUrl(url, hostOrigin, controller.signal);
        if (controller.signal.aborted || current !== revision) return;
        setResult({ url, hostOrigin, attempt, src: source.src });
        if (source.expiresAt) renewal = setTimeout(() => { void resolve(); }, Math.max(1000, source.expiresAt - Date.now() - 10_000));
      } catch {
        if (!controller.signal.aborted && current === revision) setResult({ url, hostOrigin, attempt, error: true });
      }
    };
    const local = isLoopbackHttpUrl(url);
    const release = local ? acquireRuntimeUrlAuthToken() : undefined;
    const unsubscribe = local ? subscribeRuntimeUrlAuthToken(() => { void resolve(); }) : undefined;
    void resolve();
    return () => { controller.abort(); clearTimeout(renewal); unsubscribe?.(); release?.(); };
  }, [url, hostOrigin, attempt]);
  const current = result?.url === url && result.hostOrigin === hostOrigin && result.attempt === attempt ? result : undefined;
  useEventListener('message', (event: MessageEvent) => {
    if (!current?.src || !isLoopbackHttpUrl(url) || event.source !== frame.current?.contentWindow
      || event.origin !== new URL(current.src).origin) return;
    const data = event.data;
    if (data?.source !== 'yuri-preview-bridge' || data.version !== 1 || data.type !== 'navigate-preview'
      || typeof data.url !== 'string') return;
    useMobileHtmlPreviewStore.getState().open(data.url);
  });
  if (current?.error) return <div className="flex h-full flex-col items-center justify-center gap-3">
    <FilePreviewError message={t('contextPanel.preview.proxyError')} />
    <Button size="sm" onClick={retry}>{t('contextPanel.preview.actions.retry')}</Button>
  </div>;
  if (!current?.src) return <div className="flex h-full items-center justify-center text-muted-foreground">{t('contextPanel.preview.loading')}</div>;
  return <iframe ref={frame} src={current.src} title={t('contextPanel.preview.iframeTitle')}
    onError={() => setResult({ url, hostOrigin, attempt, error: true })}
    className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin allow-forms" />;
}

export function MobileHtmlPreviewSheet() {
  const { t } = useI18n();
  const target = useMobileHtmlPreviewStore(state => state.target);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const current = target?.generation === generation ? target : null;
  return <MobileResizableSheet id="mobile-html-preview" open={Boolean(current)}
    ariaLabel={t('contextPanel.preview.iframeTitle')} closeAriaLabel={t('guiPlugins.close')}
    resizeAriaLabel={t('guiPlugins.resize')} initiallyExpanded
    title={current?.url ?? ''} onOpenChange={open => { if (!open) useMobileHtmlPreviewStore.getState().close(); }}>
    {current ? <MobileHtmlNetworkBoundary key={generation}>{network => <PreviewFrame url={current.url} hostOrigin={network?.hostOrigin} />}</MobileHtmlNetworkBoundary> : null}
  </MobileResizableSheet>;
}
