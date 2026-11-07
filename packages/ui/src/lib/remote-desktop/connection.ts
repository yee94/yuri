import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import type { DesktopInput } from './input';
export type { DesktopInput } from './input';

type DesktopConnectionOptions = {
  transport: string; generation: number;
  video: HTMLVideoElement; image: HTMLImageElement;
  onSize: (width: number, height: number) => void;
  onState: (state: 'connecting' | 'webrtc' | 'tunnel' | 'closed', error?: string) => void;
};

export function connectRemoteDesktop(options: DesktopConnectionOptions) {
  let disposed = false, failures = 0, serial = 0, zoomed = false;
  let attempt: ReturnType<typeof connectDesktopAttempt> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | undefined;
  const inScope = () => options.transport === getRuntimeTransportIdentity() && options.generation === getRuntimeGeneration();
  const hidden = () => document.visibilityState === 'hidden';
  const discard = () => {
    serial++;
    const previous = attempt;
    attempt = undefined;
    clearTimeout(retryTimer); retryTimer = undefined;
    previous?.close();
  };
  const close = (error?: string) => {
    if (disposed) return;
    disposed = true;
    discard();
    unsubscribe();
    window.removeEventListener('online', recover);
    window.removeEventListener('pageshow', pageShow);
    window.removeEventListener('yuri:system-resume', resume);
    document.removeEventListener('visibilitychange', visibility);
    options.onState('closed', error);
  };
  const schedule = () => {
    if (disposed || hidden()) return;
    const delay = navigator.onLine === false || lastError === 'permission_required'
      ? 60000 : Math.min(1000 * 2 ** Math.min(failures++, 5), 30000);
    retryTimer = setTimeout(() => { retryTimer = undefined; run(); }, delay);
  };
  const run = () => {
    if (disposed || attempt || hidden()) return;
    if (!inScope()) { close('runtime_changed'); return; }
    clearTimeout(retryTimer); retryTimer = undefined;
    if (navigator.onLine === false) { schedule(); return; }
    const expected = ++serial;
    attempt = connectDesktopAttempt({ ...options, onState: (state, error) => {
      if (disposed || expected !== serial) return;
      if (state === 'closed') {
        attempt = undefined;
        lastError = error;
        if (!error || ['runtime_changed', 'disabled', 'unsupported', 'helper_unavailable', 'authentication_required', 'permission_denied'].includes(error)) {
          close(error); return;
        }
        options.onState(state, error);
        schedule();
        return;
      }
      if (state === 'webrtc' || state === 'tunnel') { failures = 0; lastError = undefined; }
      options.onState(state, error);
    } });
    attempt.setZoomed(zoomed);
  };
  const recover = () => { if (!disposed && !hidden() && !attempt) run(); };
  const resume = () => { if (!disposed) { discard(); recover(); } };
  const pageShow = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
  const visibility = () => {
    if (hidden()) { discard(); options.onState('connecting', undefined); }
    else recover();
  };
  const unsubscribe = subscribeRuntimeEndpointChanged(() => close('runtime_changed'));
  window.addEventListener('online', recover);
  window.addEventListener('pageshow', pageShow);
  window.addEventListener('yuri:system-resume', resume);
  document.addEventListener('visibilitychange', visibility);
  run();
  return {
    send: (message: DesktopInput) => { if (!disposed && inScope()) attempt?.send(message); },
    close: () => close(),
    setZoomed: (value: boolean) => { zoomed = value; attempt?.setZoomed(value); },
  };
}

function connectDesktopAttempt(options: DesktopConnectionOptions) {
  let closed = false;
  let ws: RelayTunnelWebSocket | undefined;
  let peer: RTCPeerConnection | undefined;
  let fallback = false;
  let objectUrl: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const deadline = setTimeout(() => close('connection_failed'), 60000);
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMessage = Date.now();
  let reportedState: string | undefined;
  let reportedError: string | undefined;
  let zoomQualitySupported = false, zoomed = false, reportedZoomed = false;
  const report = (state: 'connecting' | 'webrtc' | 'tunnel' | 'closed', error?: string) => {
    if (reportedState === state && reportedError === error) return;
    reportedState = state; reportedError = error;
    options.onState(state, error);
  };
  let chain = Promise.resolve();
  let queuedSignals = 0;
  const ice: RTCIceCandidateInit[] = [];
  const current = () => !closed && options.transport === getRuntimeTransportIdentity() && options.generation === getRuntimeGeneration();
  const send = (message: unknown) => {
    if (!current() || ws?.readyState !== 1) return;
    try { ws.send(JSON.stringify(message)); } catch { close('connection_failed'); }
  };
  const syncZoom = () => {
    if (!zoomQualitySupported || zoomed === reportedZoomed || !current() || ws?.readyState !== 1) return;
    send({ type: 'view', zoomed });
    reportedZoomed = zoomed;
  };
  const close = (error?: string) => {
    if (closed) return;
    const release = current() && ws?.readyState === 1;
    closed = true;
    if (release) {
      try { ws!.send(JSON.stringify({ type: 'release' })); } catch { /* A broken transport must not prevent resource cleanup and recovery. */ }
    }
    clearInterval(heartbeat);
    clearTimeout(deadline);
    clearTimeout(fallbackTimer);
    if (ws) {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      ws.close();
    }
    peer?.close();
    const stream = options.video.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop());
    options.video.srcObject = null;
    options.video.onloadeddata = null;
    options.image.onload = null;
    options.image.onerror = null;
    options.image.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    report('closed', error);
  };
  const switchToFallback = () => {
    if (!current() || fallback) return;
    fallback = true;
    peer?.close();
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => close('connection_failed'), 15000);
    send({ type: 'fallback' });
  };
  const receive = async (data: string | ArrayBuffer) => {
    if (!current()) return;
    lastMessage = Date.now();
    if (data instanceof ArrayBuffer) {
      if (data.byteLength > 512 * 1024) { close('connection_failed'); return; }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
      options.image.onload = () => {
        if (!current()) return;
        clearTimeout(deadline);
        clearTimeout(fallbackTimer);
        options.onSize(options.image.naturalWidth, options.image.naturalHeight);
        report('tunnel');
        send({ type: 'ack' });
      };
      options.image.onerror = () => close('connection_failed');
      options.image.src = objectUrl;
      return;
    }
    const message = JSON.parse(data);
    if (message.type === 'error') { close(typeof message.code === 'string' ? message.code : 'connection_failed'); return; }
    if (message.type === 'ready') {
      zoomQualitySupported = message.zoomQuality === true;
      syncZoom();
      if (Number.isFinite(message.width) && Number.isFinite(message.height)) options.onSize(message.width, message.height);
    } else if (message.type === 'offer' && !fallback) {
      if (peer || typeof message.sdp !== 'string' || message.sdp.length > 65536) throw new Error('invalid_offer');
      if (typeof RTCPeerConnection === 'undefined') { switchToFallback(); return; }
      peer = new RTCPeerConnection({ iceServers: Array.isArray(message.iceServers) ? message.iceServers : [] });
      peer.onicecandidate = event => { if (event.candidate) send({ type: 'ice', candidate: event.candidate.toJSON() }); };
      peer.onconnectionstatechange = () => {
        if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') switchToFallback();
      };
      peer.ontrack = event => {
        if (!current()) return;
        options.video.srcObject = new MediaStream([event.track]);
        options.video.onloadeddata = () => {
          if (!current() || fallback) return;
          clearTimeout(deadline);
          clearTimeout(fallbackTimer);
          options.onSize(options.video.videoWidth, options.video.videoHeight);
          report('webrtc');
        };
        void options.video.play().catch(switchToFallback);
      };
      await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      for (const candidate of ice.splice(0)) await peer.addIceCandidate(candidate);
      await peer.setLocalDescription(await peer.createAnswer());
      if (!current() || fallback) return;
      fallbackTimer = setTimeout(switchToFallback, 7000);
      send({ type: 'answer', sdp: peer.localDescription?.sdp });
    } else if (message.type === 'ice' && message.candidate && !fallback) {
      if (peer?.remoteDescription) await peer.addIceCandidate(message.candidate);
      else if (ice.length < 128) ice.push(message.candidate);
    } else if (message.type === 'rtc-failed') switchToFallback();
  };
  report('connecting');
  void (async () => {
    try {
      await refreshRuntimeUrlAuthToken();
      if (!current()) return;
      ws = openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/remote-desktop/ws'));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (!current()) return;
        lastMessage = Date.now();
        heartbeat = setInterval(() => {
          if (!current()) { close('runtime_changed'); return; }
          if (Date.now() - lastMessage > 30000) { close('connection_failed'); return; }
          send({ type: 'ping' });
        }, 5000);
      };
      ws.onmessage = event => {
        if (!current()) return;
        if (++queuedSignals > 128) { close('connection_failed'); return; }
        chain = chain.then(() => receive(event.data)).catch(switchToFallback).finally(() => { queuedSignals--; });
      };
      ws.onerror = () => close('connection_failed');
      ws.onclose = event => close(event.code === 4001 ? 'authentication_required' : 'connection_failed');
    } catch { close('connection_failed'); }
  })();
  return { send: (message: DesktopInput) => send(message), close,
    setZoomed: (value: boolean) => { zoomed = value; syncZoom(); },
  };
}
