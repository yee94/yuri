import { app, BrowserWindow, ipcMain } from 'electron';
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
const finish = error => {
  if (finished) return;
  finished = true;
  if (error) result.error = String(error?.stack ?? error);
  console.log(`REMOTE_DESKTOP_EVIDENCE ${JSON.stringify(result)}`);
  win?.destroy(); app.quit();
};
const deadline = setTimeout(() => finish('fixture_timeout'), 20000);
const command = message => win.webContents.send('yuri:capture:command', message);
const pendingIce = [];
ipcMain.on('yuri:capture:loaded', async () => {
  try {
    result.environment = await win.webContents.executeJavaScript(`({secure:isSecureContext,mediaDevices:!!navigator.mediaDevices})`);
    await win.webContents.executeJavaScript(`
      globalThis.fixtureCanvas = document.createElement('canvas');
      fixtureCanvas.width = 640; fixtureCanvas.height = 360;
      let tick = 0;
      globalThis.fixtureClock = setInterval(() => {
        const ctx = fixtureCanvas.getContext('2d');
        ctx.fillStyle = tick++ % 2 ? '#abcdef' : '#fedcba';
        ctx.fillRect(0,0,640,360);
      }, 33);
      navigator.mediaDevices.getUserMedia = async () => fixtureCanvas.captureStream(30);
      globalThis.receiver = new RTCPeerConnection();
      receiver.onicecandidate = event => { if(event.candidate) captureBridge.send({type:'test-ice',candidate:event.candidate.toJSON()}); };
      receiver.ontrack = event => {
        const output = document.createElement('video');
        output.autoplay = output.muted = output.playsInline = true;
        output.srcObject = new MediaStream([event.track]);
        output.onloadeddata = () => captureBridge.send({type:'test-video',width:output.videoWidth,height:output.videoHeight});
        document.body.append(output); output.play();
      };
      void 0;
    `);
    command({ type: 'start', sourceId: 'synthetic-test', iceServers: [] });
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
    else if (message.type === 'test-video') {
      result.video = { width: message.width, height: message.height };
      await new Promise(resolve => setTimeout(resolve, 1500));
      result.stats = await win.webContents.executeJavaScript(`(async () => {
        const stats = await receiver.getStats();
        return [...stats.values()].filter(v => v.type === 'inbound-rtp').map(v => ({framesDecoded:v.framesDecoded,framesPerSecond:v.framesPerSecond,bytesReceived:v.bytesReceived}));
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
    } else {
      clearTimeout(deadline);
      finish();
    }
  } catch (error) { finish(error); }
});
win = new BrowserWindow({ show: false, webPreferences: {
  preload: path.join(root, 'remote-desktop-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
} });
win.webContents.on('render-process-gone', () => finish('renderer_gone'));
await win.loadFile(path.join(root, 'remote-desktop.html'));
});
