import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

export type DesktopInput =
  | { type: 'pointer'; action: 'down' | 'up' | 'move' | 'click' | 'right'; x: number; y: number }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'release' };

export function connectRemoteDesktop(options: {
  transport: string; generation: number;
  video: HTMLVideoElement; image: HTMLImageElement;
  onSize: (width: number, height: number) => void;
  onState: (state: 'connecting' | 'webrtc' | 'tunnel' | 'closed', error?: string) => void;
}) {
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
    if (current() && ws?.readyState === 1) ws.send(JSON.stringify(message));
  };
  const syncZoom = () => {
    if (!zoomQualitySupported || zoomed === reportedZoomed || !current() || ws?.readyState !== 1) return;
    send({ type: 'view', zoomed });
    reportedZoomed = zoomed;
  };
  const close = (error?: string) => {
    if (closed) return;
    send({ type: 'release' });
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(deadline);
    clearTimeout(fallbackTimer);
    ws?.close();
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
  const unsubscribe = subscribeRuntimeEndpointChanged(() => close('runtime_changed'));
  const switchToFallback = () => {
    if (!current() || fallback) return;
    fallback = true;
    peer?.close();
    clearTimeout(fallbackTimer);
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
      send({ type: 'answer', sdp: peer.localDescription?.sdp });
      fallbackTimer = setTimeout(switchToFallback, 7000);
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
        lastMessage = Date.now();
        heartbeat = setInterval(() => {
          if (!current()) { close('runtime_changed'); return; }
          if (Date.now() - lastMessage > 30000) { close('connection_failed'); return; }
          send({ type: 'ping' });
        }, 5000);
      };
      ws.onmessage = event => {
        if (++queuedSignals > 128) { close('connection_failed'); return; }
        chain = chain.then(() => receive(event.data)).catch(switchToFallback).finally(() => { queuedSignals--; });
      };
      ws.onerror = () => close('connection_failed');
      ws.onclose = () => close('connection_failed');
    } catch { close('connection_failed'); }
  })();
  return { send: (message: DesktopInput) => send(message), close,
    setZoomed: (value: boolean) => { zoomed = value; syncZoom(); },
  };
}
