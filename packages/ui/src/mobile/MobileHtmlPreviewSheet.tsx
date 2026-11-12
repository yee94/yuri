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
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import type { HostLocation } from '@/lib/remote-projects/location';
import { useRemoteProjectRuntime } from '@/queries/remoteProjectQueries';

function PreviewFrame({ url, hostOrigin, entry }: { url: string; hostOrigin?: string; entry?: HostRuntimeEntry }) {
  const { t } = useI18n();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const scope = entry ? JSON.stringify(entry.queryScope) : 'local';
  const [result, setResult] = React.useState<{ url: string; hostOrigin?: string; scope: string; attempt: number; src?: string; error?: boolean }>();
  React.useEffect(() => {
    const controller = new AbortController();
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const resolve = async () => {
      const current = ++revision;
      clearTimeout(renewal);
      try {
        const source = await resolveMobileHtmlUrl(url, hostOrigin, controller.signal, entry);
        if (controller.signal.aborted || current !== revision) return;
        setResult({ url, hostOrigin, scope, attempt, src: source.src });
        if (source.expiresAt) renewal = setTimeout(() => { void resolve(); }, Math.max(1000, source.expiresAt - Date.now() - 10_000));
      } catch {
        if (!controller.signal.aborted && current === revision) setResult({ url, hostOrigin, scope, attempt, error: true });
      }
    };
    const local = isLoopbackHttpUrl(url);
    const release = local ? acquireRuntimeUrlAuthToken() : undefined;
    const unsubscribe = local ? subscribeRuntimeUrlAuthToken(() => { void resolve(); }) : undefined;
    void resolve();
    return () => { controller.abort(); clearTimeout(renewal); unsubscribe?.(); release?.(); };
  }, [url, hostOrigin, attempt, entry, scope]);
  const current = result?.url === url && result.hostOrigin === hostOrigin && result.scope === scope && result.attempt === attempt ? result : undefined;
  useEventListener('message', (event: MessageEvent) => {
    if (!current?.src || !isLoopbackHttpUrl(url) || event.source !== frame.current?.contentWindow
      || event.origin !== new URL(current.src).origin) return;
    const data = event.data;
    if (data?.source !== 'yuri-preview-bridge' || data.version !== 1 || data.type !== 'navigate-preview'
      || typeof data.url !== 'string') return;
    useMobileHtmlPreviewStore.getState().open(data.url, entry?.location);
  });
  if (current?.error) return <div className="flex h-full flex-col items-center justify-center gap-3">
    <FilePreviewError message={t('contextPanel.preview.proxyError')} />
    <Button size="sm" onClick={retry}>{t('contextPanel.preview.actions.retry')}</Button>
  </div>;
  if (!current?.src) return <div className="flex h-full items-center justify-center text-muted-foreground">{t('contextPanel.preview.loading')}</div>;
  return <iframe ref={frame} src={current.src} title={t('contextPanel.preview.iframeTitle')}
    onError={() => setResult({ url, hostOrigin, scope, attempt, error: true })}
    className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin allow-forms" />;
}

function RemotePreviewTarget({ location, url, hostOrigin }: { location: HostLocation; url: string; hostOrigin?: string }) {
  const { t } = useI18n();
  const runtime = useRemoteProjectRuntime(true);
  if (!runtime.registry || runtime.registry.hubId !== location.hubId) return runtime.error
    ? <FilePreviewError message={runtime.error.message} /> : <div className="text-muted-foreground">{t('contextPanel.preview.loading')}</div>;
  return <PreviewFrame url={url} hostOrigin={hostOrigin} entry={runtime.registry.resolve(location)} />;
}

export function MobileHtmlPreviewSheet() {
  const { t } = useI18n();
  const target = useMobileHtmlPreviewStore(state => state.target);
  const host = useHostRuntime();
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const current = target?.generation === generation ? target : null;
  return <MobileResizableSheet id="mobile-html-preview" open={Boolean(current)}
    ariaLabel={t('contextPanel.preview.iframeTitle')} closeAriaLabel={t('guiPlugins.close')}
    resizeAriaLabel={t('guiPlugins.resize')} initiallyExpanded
    title={current?.url ?? ''} onOpenChange={open => { if (!open) useMobileHtmlPreviewStore.getState().close(); }}>
    {current ? <MobileHtmlNetworkBoundary key={generation}>{network => current.location?.hostId
      ? host?.entry.location.hubId === current.location.hubId && host.entry.location.hostId === current.location.hostId && host.entry.location.directory === current.location.directory
        ? <PreviewFrame url={current.url} hostOrigin={network?.hostOrigin} entry={host.entry} />
        : <RemotePreviewTarget location={current.location} url={current.url} hostOrigin={network?.hostOrigin} />
      : <PreviewFrame url={current.url} hostOrigin={network?.hostOrigin} />}</MobileHtmlNetworkBoundary> : null}
  </MobileResizableSheet>;
}
