import { createJpegFrameFilter, createVideoQualityController } from './remote-desktop-quality.mjs';

const bridge = window.captureBridge;
const video = document.querySelector('video');
const canvas = document.querySelector('canvas');
const quality = createVideoQualityController();
const frames = createJpegFrameFilter();
let peer, stream, sender, appliedQuality, fallback = false, waiting = false, capturing = false, timer, adaptiveTimer;
let disposed = false, adapting = false, starting = false;
let applying = false, zoomed = false, viewRevision = 0, lastFrameAt = -Infinity;
let pendingIce = [];
const report = () => { if (!disposed) bridge.send({ type: 'failure' }); };

async function applyQuality() {
  if (disposed || fallback || applying || !sender) return;
  applying = true;
  try {
    while (!disposed && !fallback && quality.current !== appliedQuality) {
      const value = quality.current;
      const { degradationPreference = 'balanced', ...encodingQuality } = value;
      // Normal tiers are based on a 1080p reference; a larger capture must not raise their output or bandwidth demand.
      if (degradationPreference !== 'maintain-resolution') encodingQuality.scaleResolutionDownBy = Math.max(1,
        encodingQuality.scaleResolutionDownBy * Math.max(video.videoWidth / 1920, video.videoHeight / 1080));
      const params = sender.getParameters();
      params.encodings ??= [{}];
      for (const encoding of params.encodings) Object.assign(encoding, encodingQuality);
      params.degradationPreference = degradationPreference;
      await sender.setParameters(params);
      if (!disposed && !fallback) appliedQuality = value;
    }
  } finally { applying = false; }
}

async function adapt() {
  if (disposed || fallback || adapting || peer?.connectionState !== 'connected') return;
  adapting = true;
  try {
    const stats = await peer.getStats();
    if (!disposed && !fallback) { quality.sample(stats); await applyQuality(); }
  } catch {
    // An unavailable stats/parameter API must not interrupt working video. Keep the last applied settings and retry.
    quality.sample(new Map());
  } finally { adapting = false; }
}

async function frame() {
  if (disposed || !fallback || waiting || capturing || !video.videoWidth) return;
  const now = performance.now();
  if (now - lastFrameAt < (zoomed ? 250 : 83)) return;
  lastFrameAt = now;
  const revision = viewRevision;
  capturing = true;
  try {
    const factor = Math.min(1, (zoomed ? 2560 : 1440) / video.videoWidth, (zoomed ? 1440 : 900) / video.videoHeight);
    const width = Math.round(video.videoWidth * factor), height = Math.round(video.videoHeight * factor);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    let blob;
    for (const jpegQuality of zoomed ? [0.8, 0.5, 0.25] : [0.65]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', jpegQuality));
      if (disposed || revision !== viewRevision) return;
      if (!blob || blob.size <= 512 * 1024) break;
    }
    if (!blob || blob.size > 512 * 1024 || disposed || !fallback) return;
    const bytes = await blob.arrayBuffer();
    if (disposed || !fallback || revision !== viewRevision || !frames.shouldSend(bytes)) return;
    waiting = true;
    bridge.frame(bytes);
  } finally { capturing = false; }
}

bridge.onMessage(async message => {
  if (disposed) return;
  try {
    if (message.type === 'start' && !starting) {
      starting = true;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: message.sourceId,
        maxWidth: 2560, maxHeight: 1440, maxFrameRate: 30,
      } } });
      if (disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      video.srcObject = stream;
      await video.play();
      if (disposed) return;
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'detail';
      track.onended = report;
      bridge.send({ type: 'ready', width: video.videoWidth, height: video.videoHeight, zoomQuality: message.zoomQuality === true });
      peer = new RTCPeerConnection({ iceServers: message.iceServers });
      peer.onicecandidate = event => { if (event.candidate && !disposed && !fallback) bridge.send({ type: 'ice', candidate: event.candidate.toJSON() }); };
      sender = peer.addTrack(track, stream);
      try { await applyQuality(); } catch { /* Keep Chromium's defaults if tuning is unavailable. */ }
      if (disposed) return;
      await peer.setLocalDescription(await peer.createOffer());
      if (disposed) return;
      bridge.send({ type: 'offer', sdp: peer.localDescription.sdp });
      adaptiveTimer = setInterval(() => { void adapt(); }, 2000);
    } else if (message.type === 'answer' && !fallback) {
      await peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      for (const candidate of pendingIce) await peer.addIceCandidate(candidate);
      pendingIce = [];
    } else if (message.type === 'ice' && !fallback) {
      if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
      else if (pendingIce.length < 128) pendingIce.push(message.candidate);
    } else if (message.type === 'fallback' && !fallback) {
      fallback = true;
      clearInterval(adaptiveTimer);
      pendingIce = [];
      peer?.close();
      bridge.send({ type: 'transport', transport: 'tunnel' });
      timer = setInterval(() => { void frame().catch(report); }, 83);
    } else if (message.type === 'view' && typeof message.zoomed === 'boolean' && message.zoomed !== zoomed) {
      zoomed = message.zoomed;
      quality.setZoomed(zoomed);
      viewRevision++;
      frames.clear();
      lastFrameAt = -Infinity;
      try { await applyQuality(); } catch { /* Keep working video; the next stats sample retries tuning. */ }
    } else if (message.type === 'ack') {
      if (message.dropped) frames.clear();
      waiting = false;
    }
  } catch { if (!disposed) { if (stream) bridge.send({ type: 'rtc-failed' }); else report(); } }
});
window.addEventListener('unload', () => {
  disposed = true;
  clearInterval(timer);
  clearInterval(adaptiveTimer);
  frames.clear();
  pendingIce = [];
  peer?.close();
  stream?.getTracks().forEach(track => track.stop());
});
bridge.loaded();
