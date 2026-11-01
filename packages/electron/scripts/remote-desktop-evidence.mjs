import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


// Synthetic canvas only: this fixture never captures or controls the user's desktop.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setPath('userData', process.argv[2]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
let win;
let finished = false;
const result = { frames: 0, bytes: 0 };
let retryBytes;
const finish = error => {
  if (finished) return;
  finished = true;
  if (error) result.error = String(error?.stack ?? error);
  console.log(`REMOTE_DESKTOP_EVIDENCE ${JSON.stringify(result)}`);
  win?.destroy(); app.quit();
};
const deadline = setTimeout(() => finish('fixture_timeout'), 45000);
const command = message => win.webContents.send('yuri:capture:command', message);
const pendingIce = [];
ipcMain.on('yuri:capture:loaded', async () => {
  try {
    result.environment = await win.webContents.executeJavaScript(`({secure:isSecureContext,mediaDevices:!!navigator.mediaDevices})`);
    await win.webContents.executeJavaScript(`
      globalThis.fixtureCanvas = document.createElement('canvas');
      fixtureCanvas.width = 2560; fixtureCanvas.height = 1440;
      let tick = 0;
      globalThis.fixtureClock = setInterval(() => {
        const ctx = fixtureCanvas.getContext('2d');
        ctx.fillStyle = tick++ % 2 ? '#abcdef' : '#fedcba';
        ctx.fillRect(0,0,2560,1440);
      }, 33);
      navigator.mediaDevices.getUserMedia = async () => fixtureCanvas.captureStream(30);
      globalThis.fixtureEncodings = [];
      const setParameters = RTCRtpSender.prototype.setParameters;
      RTCRtpSender.prototype.setParameters = async function(params) {
        await setParameters.call(this, params);
        const applied = this.getParameters();
        fixtureEncodings.push({...applied.encodings[0], degradationPreference:applied.degradationPreference});
      };
      const getStats = RTCPeerConnection.prototype.getStats;
      RTCPeerConnection.prototype.getStats = async function(...args) {
        const nativeStats = await getStats.apply(this, args);
        const stats = new Map([...nativeStats].map(([id, stat]) => [id, {...stat}]));
        if (this === globalThis.receiver || !globalThis.fixtureNetwork) return stats;
        // Controlled feedback exercises the production controller and real encoder, not a real WAN.
        for (const stat of stats.values()) {
          if (stat.type === 'outbound-rtp' && stat.kind === 'video') stat.qualityLimitationReason = fixtureNetwork === 'poor' ? 'bandwidth' : 'none';
          if (stat.type === 'candidate-pair') { stat.availableOutgoingBitrate = fixtureNetwork === 'poor' ? 500000 : 5000000; stat.currentRoundTripTime = 0.05; }
          if (stat.type === 'remote-inbound-rtp') { stat.fractionLost = 0; stat.roundTripTime = 0.05; }
        }
        globalThis.fixtureFeedback = [...stats.values()].filter(stat => ['outbound-rtp', 'candidate-pair', 'transport'].includes(stat.type))
          .map(stat => ({type:stat.type,kind:stat.kind,bytesSent:stat.bytesSent,qualityLimitationReason:stat.qualityLimitationReason,
            availableOutgoingBitrate:stat.availableOutgoingBitrate,currentRoundTripTime:stat.currentRoundTripTime}));
        return stats;
      };
      globalThis.receiver = new RTCPeerConnection();
      receiver.onicecandidate = event => { if(event.candidate) captureBridge.send({type:'test-ice',candidate:event.candidate.toJSON()}); };
      receiver.ontrack = event => {
        const output = document.createElement('video');
        globalThis.fixtureOutput = output;
        output.autoplay = output.muted = output.playsInline = true;
        output.srcObject = new MediaStream([event.track]);
        output.onloadeddata = () => captureBridge.send({type:'test-video',width:output.videoWidth,height:output.videoHeight});
        document.body.append(output); output.play();
      };
      void 0;
    `);
    command({ type: 'start', sourceId: 'synthetic-test', iceServers: [], zoomQuality: true });
  } catch (error) { finish(error); }
});
ipcMain.on('yuri:capture:message', async (_event, message) => {
  try {
    if (message.type === 'failure' || message.type === 'rtc-failed') return finish(message.type);
    if (message.type === 'offer') {
      await win.webContents.executeJavaScript(`(async () => {
        await receiver.setRemoteDescription(${JSON.stringify({ type: 'offer', sdp: message.sdp })});
        await receiver.setLocalDescription(await receiver.createAnswer());
        captureBridge.send({type:'test-answer',sdp:receiver.localDescription.sdp});
      })()`);
      for (const candidate of pendingIce.splice(0)) await win.webContents.executeJavaScript(`receiver.addIceCandidate(${JSON.stringify(candidate)})`);
    } else if (message.type === 'ice') {
      if (await win.webContents.executeJavaScript('!!globalThis.receiver?.remoteDescription')) await win.webContents.executeJavaScript(`receiver.addIceCandidate(${JSON.stringify(message.candidate)})`);
      else pendingIce.push(message.candidate);
    } else if (message.type === 'test-answer') command({ type: 'answer', sdp: message.sdp });
    else if (message.type === 'test-ice') command({ type: 'ice', candidate: message.candidate });
    else if (message.type === 'test-video' && !result.video) {
      result.video = { width: message.width, height: message.height };
      await new Promise(resolve => setTimeout(resolve, 1500));
      result.stats = await win.webContents.executeJavaScript(`(async () => {
        const stats = await receiver.getStats();
        return [...stats.values()].filter(v => v.type === 'inbound-rtp').map(v => ({framesDecoded:v.framesDecoded,framesPerSecond:v.framesPerSecond,bytesReceived:v.bytesReceived}));
      })()`);
      result.encoding = await win.webContents.executeJavaScript(`(async () => {
        globalThis.fixtureWaitFor = async predicate => {
          const deadline = performance.now() + 22000;
          while (!predicate()) {
            if (performance.now() > deadline) throw Error('encoding_adaptation_timeout ' + JSON.stringify({encodings:fixtureEncodings,feedback:globalThis.fixtureFeedback}));
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        };
        const initial = fixtureEncodings.at(-1);
        globalThis.fixtureNetwork = 'poor';
        await fixtureWaitFor(() => fixtureEncodings.at(-1).maxBitrate < initial.maxBitrate);
        const reduced = fixtureEncodings.at(-1);
        globalThis.fixtureNetwork = 'healthy';
        await fixtureWaitFor(() => fixtureEncodings.at(-1).maxBitrate === initial.maxBitrate);
        const recovered = fixtureEncodings.at(-1);
        return {initial, reduced, recovered};
      })()`);
      command({ type: 'view', zoomed: true });
      result.zoomEncoding = await win.webContents.executeJavaScript(`(async () => {
        await fixtureWaitFor(() => fixtureEncodings.at(-1).scaleResolutionDownBy === 1 && fixtureOutput.videoWidth === 2560);
        return {parameters:fixtureEncodings.at(-1), width:fixtureOutput.videoWidth, height:fixtureOutput.videoHeight};
      })()`);
      command({ type: 'view', zoomed: false });
      result.fitEncoding = await win.webContents.executeJavaScript(`(async () => {
        await fixtureWaitFor(() => fixtureEncodings.at(-1).scaleResolutionDownBy === 2);
        const applied = fixtureEncodings.at(-1);
        clearInterval(fixtureClock);
        const ctx = fixtureCanvas.getContext('2d');
        ctx.fillStyle = '#123456'; ctx.fillRect(0,0,2560,1440);
        await new Promise(resolve => setTimeout(resolve, 150));
        return applied;
      })()`);
      result.duplicateComparison = await win.webContents.executeJavaScript(`(async () => {
        const {createJpegFrameFilter} = await import('./remote-desktop-quality.mjs');
        const filter = createJpegFrameFilter(), data = new ArrayBuffer(512 * 1024), times = [];
        filter.shouldSend(data);
        let sent = 0;
        for (let i = 0; i < 300; i++) {
          const start = performance.now();
          if (filter.shouldSend(data)) sent++;
          times.push(performance.now() - start);
        }
        times.sort((a,b) => a-b);
        return {samples:times.length,bytes:data.byteLength,duplicateSends:sent,medianMs:times[150],p95Ms:times[285],maxMs:times.at(-1)};
      })()`);
      command({ type: 'fallback' });
    }
  } catch (error) { finish(error); }
});
ipcMain.on('yuri:capture:frame', async (_event, bytes) => {
  try {
    result.frames++; result.bytes += bytes.byteLength;
    if (new Uint8Array(bytes)[0] !== 255 || new Uint8Array(bytes)[1] !== 216) throw Error('invalid_jpeg');
    if (result.frames === 1) {
      await new Promise(resolve => setTimeout(resolve, 350));
      result.framesWithoutAck = result.frames;
      command({ type: 'ack' });
      await new Promise(resolve => setTimeout(resolve, 850));
      result.idleFrames = result.frames - 1;
      await win.webContents.executeJavaScript(`{
        const ctx = fixtureCanvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(2544,1424,8,8);
      }`);
    } else if (result.frames === 2) {
      retryBytes = Buffer.from(bytes);
      command({ type: 'ack', dropped: true });
    } else if (result.frames === 3) {
      result.retriedDroppedFrame = retryBytes.equals(Buffer.from(bytes));
      command({ type: 'ack' });
      await new Promise(resolve => setTimeout(resolve, 350));
      command({ type: 'view', zoomed: true });
    } else if (result.frames === 4) {
      result.zoomJpegSize = nativeImage.createFromBuffer(Buffer.from(bytes)).getSize();
      command({ type: 'ack' });
      command({ type: 'view', zoomed: false });
    } else if (result.frames === 5) {
      result.fitJpegSize = nativeImage.createFromBuffer(Buffer.from(bytes)).getSize();
      command({ type: 'ack' });
      await new Promise(resolve => setTimeout(resolve, 350));
      clearTimeout(deadline);
      finish();
    }
  } catch (error) { finish(error); }
});
win = new BrowserWindow({ show: false, webPreferences: {
  preload: path.join(process.argv[3] ?? root, 'remote-desktop-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
} });
win.webContents.on('render-process-gone', () => finish('renderer_gone'));
await win.loadFile(path.join(process.argv[3] ?? root, 'remote-desktop.html'));
});
