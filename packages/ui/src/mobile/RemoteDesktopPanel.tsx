import * as React from 'react';
import { createPortal } from 'react-dom';
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { holdNativeComposerCover } from '@/lib/nativeComposerCover';
import { mobileBackNavigationCoordinator, useMobileBackRoute } from './mobileBackNavigation';
import { useI18n } from '@/lib/i18n';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { connectRemoteDesktop, type DesktopInput } from '@/lib/remote-desktop/connection';
import { createDesktopGestures, type DesktopInteractionMode, type DesktopViewport } from '@/lib/remote-desktop/gestures';
import { desktopLocalPoint } from '@/lib/remote-desktop/orientation';
import { useDesktopOrientation } from '@/lib/remote-desktop/useDesktopOrientation';
import { useRemoteDesktopCapability } from '@/queries/remoteDesktopQueries';

const navigationKeys: { key: string; icon: IconName }[] = [
  { key: 'Escape', icon: 'corner-up-left' },
  { key: 'Tab', icon: 'arrow-right-to-line' },
  { key: 'Backspace', icon: 'delete-back' },
  { key: 'Enter', icon: 'corner-down-left' },
  { key: 'ArrowLeft', icon: 'arrow-left' },
  { key: 'ArrowUp', icon: 'arrow-up' },
  { key: 'ArrowDown', icon: 'arrow-down' },
  { key: 'ArrowRight', icon: 'arrow-right' },
];

function RemoteDesktopPanelImpl({ onClose, instanceName }: { onClose: () => void; instanceName?: string }) {
  const { t } = useI18n();
  const [scope] = React.useState(() => ({ transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }));
  const capability = useRemoteDesktopCapability(scope.transport, scope.generation);
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<'connecting' | 'webrtc' | 'tunnel' | 'closed'>('connecting');
  const [error, setError] = React.useState<string>();
  const [mode, setMode] = React.useState<DesktopInteractionMode>('drag');
  const [keyboardOpen, setKeyboardOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const pageRef = React.useRef<HTMLDivElement>(null);
  const orientation = useDesktopOrientation(pageRef);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const imageRef = React.useRef<HTMLImageElement>(null);
  const geometry = React.useRef<DesktopViewport>({ width: 1, height: 1, remoteWidth: 1920, remoteHeight: 1080 });
  const connection = React.useRef<ReturnType<typeof connectRemoteDesktop> | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const moves = React.useRef(new Map<number, { x: number; y: number }>());
  const activePointers = React.useRef(new Set<number>());
  const zoomedRef = React.useRef(false);
  const send = useEvent((input: DesktopInput) => { connection.current?.send(input); });
  const getMode = useEvent(() => mode);
  const [gestures] = React.useState(() => createDesktopGestures({
    viewport: () => geometry.current,
    send,
    mode: getMode,
    apply: (value, settle) => {
      const zoomed = value.scale > (zoomedRef.current ? 1.01 : 1.05);
      if (zoomed !== zoomedRef.current) {
        zoomedRef.current = zoomed;
        connection.current?.setZoomed(zoomed);
      }
      if (!stageRef.current) return;
      stageRef.current.style.transition = settle && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'transform 180ms ease-out' : 'none';
      stageRef.current.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.scale})`;
    },
  }));
  const flushMoves = useEvent(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (moves.current.size && viewportRef.current) {
      const rect = viewportRef.current.getBoundingClientRect();
      const points = new Map([...moves.current].map(([id, point]) => [id, desktopLocalPoint(point, rect, orientation.rotation)]));
      gestures.moveMany(points);
    }
    moves.current.clear();
  });
  const stop = useEvent(() => {
    flushMoves(); gestures.reset();
    connection.current?.close(); connection.current = null;
  });
  const closePage = useEvent(() => { stop(); onClose(); });
  useMobileBackRoute({ id: 'remote-desktop-page', active: true, layer: 'root', onBack: closePage, surfaceRef: pageRef });
  React.useEffect(() => holdNativeComposerCover('remote-desktop-page'), []);
  React.useLayoutEffect(() => {
    const previous = document.activeElement;
    pageRef.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); mobileBackNavigationCoordinator.requestBrowserBack(); }
  }, () => document);
  const handleState = useEvent((next: typeof state, code?: string) => { setState(next); setError(code); });
  const handleSize = useEvent((width: number, height: number) => {
    if (width <= 0 || height <= 0 || (geometry.current.remoteWidth === width && geometry.current.remoteHeight === height)) return;
    const previous = geometry.current;
    geometry.current = { ...previous, remoteWidth: width, remoteHeight: height };
    // Encoder/JPEG downscaling keeps the aspect ratio, so the fitted layout is unchanged and zoom must survive it.
    const sameAspect = Math.abs(previous.remoteWidth / previous.remoteHeight - width / height) < 0.01;
    if (!sameAspect && !activePointers.current.size) gestures.reset();
  });
  useResizeObserver(viewportRef, ([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    const changed = Math.abs(geometry.current.width - width) >= 1 || Math.abs(geometry.current.height - height) >= 1;
    geometry.current = { ...geometry.current, width, height };
    if (changed && !activePointers.current.size) gestures.refit();
  });
  // Match image preview: Android can start native panning on transformed layers despite touch-action.
  useEventListener('touchmove', event => {
    if (event.cancelable) event.preventDefault();
  }, viewportRef, { passive: false });
  useEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stop(); }, () => document);
  React.useEffect(() => {
    if (!capability.data?.supported || !capability.data.enabled || !videoRef.current || !imageRef.current) return;
    const active = connectRemoteDesktop({ ...scope, video: videoRef.current, image: imageRef.current, onSize: handleSize, onState: handleState });
    connection.current = active;
    active.setZoomed(zoomedRef.current);
    return () => { active.close(); connection.current = null; };
  }, [capability.data?.supported, capability.data?.enabled, scope, attempt, handleSize, handleState]);
  React.useEffect(() => () => { flushMoves(); gestures.reset(); }, [flushMoves, gestures]);

  const point = (event: React.PointerEvent) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return desktopLocalPoint({ x: event.clientX, y: event.clientY }, rect, orientation.rotation);
  };
  const live = state === 'webrtc' || state === 'tunnel';
  const unsupported = capability.data?.supported === false || capability.error?.message === 'unsupported';
  const disabled = capability.data?.supported === true && capability.data.enabled !== true;
  const permission = error === 'permission_required';
  const message = unsupported || error === 'helper_unavailable' ? t('remoteDesktop.unsupported')
    : disabled || error === 'disabled' ? t('settings.remoteDesktop.disabled')
    : permission ? t('remoteDesktop.permissions')
    : error === 'permission_denied' ? t('remoteDesktop.denied')
    : error === 'runtime_changed' || capability.error?.message === 'runtime_changed' ? t('remoteDesktop.runtimeChanged')
    : error || capability.error || state === 'closed' ? t('remoteDesktop.failed')
    : t('remoteDesktop.connecting');
  return createPortal(
    <div ref={pageRef} tabIndex={-1} data-remote-desktop-page className="yuri-keyboard-inset-surface yuri-keyboard-inset-snap fixed inset-0 z-[150] overflow-hidden bg-background text-foreground outline-none">
      <main aria-label={instanceName ? `${t('remoteDesktop.title')} · ${instanceName}` : t('remoteDesktop.title')}
        className="absolute left-0 top-0 flex flex-col overflow-hidden bg-background"
        style={{ width: orientation.width, height: orientation.height, transformOrigin: 'top left',
          ...{
            '--desktop-safe-top': `env(safe-area-inset-${orientation.rotation === 90 ? 'right' : orientation.rotation === -90 ? 'left' : 'top'}, 0px)`,
            '--desktop-safe-right': `env(safe-area-inset-${orientation.rotation === 90 ? 'bottom' : orientation.rotation === -90 ? 'top' : 'right'}, 0px)`,
            '--desktop-safe-bottom': `env(safe-area-inset-${orientation.rotation === 90 ? 'left' : orientation.rotation === -90 ? 'right' : 'bottom'}, 0px)`,
            '--desktop-safe-left': `env(safe-area-inset-${orientation.rotation === 90 ? 'top' : orientation.rotation === -90 ? 'bottom' : 'left'}, 0px)`,
          },
          transform: orientation.rotation === 90 ? `translateX(${orientation.height}px) rotate(90deg)`
            : orientation.rotation === -90 ? `translateY(${orientation.width}px) rotate(-90deg)` : undefined }}>
       <div data-remote-desktop-stage-region className="relative min-h-0 flex-1 overflow-hidden">
       <div ref={viewportRef} className="absolute inset-0 touch-none overflow-hidden bg-background"
        aria-label={t('remoteDesktop.screen')}
        onPointerDown={event => {
          if (!live) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          activePointers.current.add(event.pointerId);
          flushMoves(); gestures.down(event.pointerId, point(event));
        }}
        onPointerMove={event => {
          if (!live || !activePointers.current.has(event.pointerId)) return;
          event.preventDefault();
          moves.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushMoves);
        }}
        onPointerUp={event => {
          flushMoves(); gestures.up(event.pointerId, point(event));
          activePointers.current.delete(event.pointerId);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={event => {
          flushMoves(); gestures.up(event.pointerId, point(event), true);
          activePointers.current.delete(event.pointerId);
        }}
        onContextMenu={event => event.preventDefault()}>
        <div ref={stageRef} className="absolute inset-0 origin-top-left will-change-transform">
          <video ref={videoRef} autoPlay muted playsInline className="pointer-events-none absolute inset-0 size-full object-contain" style={{ visibility: state === 'webrtc' ? 'visible' : 'hidden' }} />
          <img ref={imageRef} alt={t('remoteDesktop.screen')} draggable={false} className="pointer-events-none absolute inset-0 size-full object-contain" style={{ visibility: state === 'tunnel' ? 'visible' : 'hidden' }} />
        </div>
        {!live && <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-sm text-muted-foreground" role="status">
          {state === 'connecting' && !error && !capability.error && !unsupported && !disabled && <Icon name="loader-4" className="size-5 animate-spin" />}
          <p>{message}</p>
          {(state === 'closed' || capability.error || disabled) && !unsupported && error !== 'runtime_changed' && capability.error?.message !== 'runtime_changed' && <Button onClick={() => {
            stop(); setError(undefined); setState('connecting');
            if (capability.error || disabled) void capability.refetch(); else setAttempt(value => value + 1);
          }}>{t('remoteDesktop.retry')}</Button>}
        </div>}
      </div>
      <div className="pointer-events-none absolute left-[max(0.75rem,var(--desktop-safe-left))] right-[max(0.75rem,var(--desktop-safe-right))] top-[max(0.75rem,var(--desktop-safe-top))] flex items-start justify-between gap-3">
        <Button size="mobileIcon" variant="mobileGlass" className="pointer-events-auto"
          aria-label={t('header.actions.backAria')} onClick={() => mobileBackNavigationCoordinator.requestBrowserBack()}><Icon name="arrow-left" className="size-5" /></Button>
        <Button size="mobileIcon" variant="mobileGlass" className="pointer-events-auto"
          aria-label={t('remoteDesktop.rotate')} title={t('remoteDesktop.rotate')}
          onClick={() => { flushMoves(); gestures.reset(); setKeyboardOpen(false); orientation.toggle(); }}><Icon name="smartphone" className="size-5 rotate-45" /></Button>
      </div>
      <p className="sr-only">{t('remoteDesktop.hint')}</p>
      <div className="pointer-events-none absolute left-[max(0.75rem,var(--desktop-safe-left))] right-[max(0.75rem,var(--desktop-safe-right))] bottom-[max(0.75rem,var(--desktop-safe-bottom))] top-[calc(4rem+var(--desktop-safe-top))] flex flex-col items-end justify-end gap-3">
        <div className="flex w-full shrink-0 items-end justify-between gap-3">
          <div className="pointer-events-auto flex gap-3">
            <Button size="mobileIcon" variant="mobileGlass" className={mode === 'drag' ? 'yuri-mobile-inverse-action' : undefined}
              aria-label={t('remoteDesktop.drag')} title={t('remoteDesktop.drag')} aria-pressed={mode === 'drag'} disabled={!live}
              onClick={() => { flushMoves(); gestures.cancel(); setMode('drag'); }}><Icon name="hand" className="size-5" /></Button>
            <Button size="mobileIcon" variant="mobileGlass" className={mode === 'cursor' ? 'yuri-mobile-inverse-action' : undefined}
              aria-label={t('remoteDesktop.cursor')} title={t('remoteDesktop.cursor')} aria-pressed={mode === 'cursor'} disabled={!live}
              onClick={() => { flushMoves(); gestures.cancel(); setMode('cursor'); }}><Icon name="cursor" className="size-5" /></Button>
          </div>
          <Button size="mobileIcon" variant="mobileGlass" className={`pointer-events-auto${keyboardOpen ? ' yuri-mobile-inverse-action' : ''}`}
            disabled={!live} aria-label={t('remoteDesktop.text')} title={t('remoteDesktop.text')} aria-pressed={keyboardOpen} aria-expanded={keyboardOpen}
            onClick={() => setKeyboardOpen(value => !value)}><Icon name="keyboard" className="size-5" /></Button>
        </div>
       </div>
       </div>
       {keyboardOpen && <footer data-remote-desktop-keyboard className="max-h-[50%] w-full shrink-0 overflow-y-auto overscroll-contain border-t border-border bg-[var(--surface-elevated)] pt-3 pl-[max(0.75rem,var(--desktop-safe-left))] pr-[max(0.75rem,var(--desktop-safe-right))] pb-[max(0.75rem,var(--desktop-safe-bottom))]">
         <form className="flex gap-2" onSubmit={event => {
           event.preventDefault(); if (text && live) { send({ type: 'text', text }); setText(''); }
         }}>
           <Input className="min-w-0 flex-1" value={text} maxLength={1024} onChange={event => setText(event.target.value)} placeholder={t('remoteDesktop.text')} aria-label={t('remoteDesktop.text')} disabled={!live} autoComplete="off" />
           <Button type="submit" size="icon" disabled={!live || !text} aria-label={t('remoteDesktop.send')}><Icon name="send-plane-2" className="size-4" /></Button>
         </form>
          <div className="mt-2 grid grid-cols-4 gap-1 min-[360px]:grid-cols-8">
           {navigationKeys.map(({ key, icon }) => (
             <Button key={key} size="icon" variant="ghost" className="w-full" disabled={!live} onClick={() => send({ type: 'key', key })}
               aria-label={t('remoteDesktop.pressKey', { key })} title={t('remoteDesktop.pressKey', { key })}>
               <Icon name={icon} className="size-4" />
             </Button>
           ))}
         </div>
       </footer>}
       </main>
    </div>, document.body,
  );
}

export const RemoteDesktopPanel = React.memo(RemoteDesktopPanelImpl);
