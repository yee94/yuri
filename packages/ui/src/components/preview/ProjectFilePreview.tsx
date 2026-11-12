import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { FilePreviewError } from '@/components/ui/FilePreviewError';
import { MobileHtmlNetworkBoundary } from './MobileHtmlNetworkBoundary';
import { resolveProjectFilePreview } from '@/lib/preview/project-file-preview';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { acquireRuntimeUrlAuthToken, subscribeRuntimeUrlAuthToken, getRuntimeAuthGeneration, subscribeRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { attachIframeSheetOverscroll } from '@/components/ui/iframeSheetOverscroll';

type Props = { path: string; directory: string; entry?: HostRuntimeEntry; revision?: number;
  className?: string; iframeClassName?: string; iframeStyle?: React.CSSProperties };
type Source = Awaited<ReturnType<typeof resolveProjectFilePreview>>;

/** Both file surfaces execute the same scoped, revocable resource graph. */
export function ProjectFilePreview(props: Props) {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const auth = React.useSyncExternalStore(subscribeRuntimeAuthGeneration, getRuntimeAuthGeneration, getRuntimeAuthGeneration);
  const key = JSON.stringify([generation, auth, props.entry?.queryScope, props.path, props.directory, props.revision]);
  return <MobileHtmlNetworkBoundary key={key}>{network => <FileDocument key={network?.hostOrigin ?? ''} {...props} hostOrigin={network?.hostOrigin} />}</MobileHtmlNetworkBoundary>;
}

function FileDocument({ path, directory, entry, hostOrigin, className, iframeClassName, iframeStyle }: Props & { hostOrigin?: string }) {
  const { t } = useI18n();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const [result, setResult] = React.useState<{ attempt: number; source?: Source; failed?: boolean }>();
  const current = result?.attempt === attempt ? result : undefined;
  const failed = current?.failed === true;
  React.useEffect(() => {
    if (failed) return;
    const controller = new AbortController();
    let source: Source | undefined;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let resolving = false;
    let tokenChanged = false;
    const resolve = async () => {
      if (controller.signal.aborted || resolving) return;
      resolving = true;
      clearTimeout(renewal);
      setResult(undefined);
      const previous = source;
      source = undefined;
      void previous?.release().catch(() => {});
      try {
        const next = await resolveProjectFilePreview(entry, path, directory, controller.signal, hostOrigin);
        if (controller.signal.aborted || tokenChanged) { void next.release().catch(() => {}); return; }
        source = next;
        setResult({ attempt, source: next });
        renewal = setTimeout(() => { void resolve(); }, Math.max(1000, next.expiresAt - Date.now() - 10_000));
      } catch {
        if (!controller.signal.aborted && !tokenChanged) setResult({ attempt, failed: true });
      } finally {
        resolving = false;
        if (tokenChanged && !controller.signal.aborted) { tokenChanged = false; void resolve(); }
      }
    };
    const releaseAuth = acquireRuntimeUrlAuthToken();
    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      if (resolving) { tokenChanged = true; setResult(undefined); }
      else void resolve();
    });
    void resolve();
    return () => {
      controller.abort(); clearTimeout(renewal); unsubscribe(); releaseAuth();
      void source?.release().catch(() => {});
    };
  }, [path, directory, entry, hostOrigin, attempt, failed]);
  React.useEffect(() => {
    if (current?.source && frame.current) return attachIframeSheetOverscroll(frame.current);
  }, [current?.source]);
  if (failed) return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
    <FilePreviewError message={t('contextPanel.preview.proxyError')} />
    <Button size="sm" onClick={retry}>{t('contextPanel.preview.actions.retry')}</Button>
  </div>;
  if (!current?.source) return <div className="flex h-full items-center justify-center text-muted-foreground">{t('contextPanel.preview.loading')}</div>;
  return <div className={className ?? 'h-full overflow-hidden'}><iframe ref={frame} src={current.source.src}
    className={iframeClassName ?? 'h-full w-full border-none'} style={iframeStyle}
    sandbox="allow-scripts allow-same-origin allow-forms" title={t('filesView.editor.htmlPreviewTitle')}
    onErrorCapture={() => setResult({ attempt, failed: true })} /></div>;
}
