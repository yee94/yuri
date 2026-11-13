// Runs INSIDE Electron. Imports the unmodified owning shell and full production UI.
import { app, BrowserWindow, clipboard, contentTracing } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { observeTerminalFrame } from './terminal-frame-observer.mjs';

const config = JSON.parse(fs.readFileSync(process.env.REMOTE_PROJECTS_PROBE_CONFIG, 'utf8'));
const startedAt = Date.now();
const stages = [];
const record = (stage, detail = {}) => {
  const entry = { stage, epochMs: Date.now(), elapsedMs: Date.now() - startedAt, ...detail };
  stages.push(entry);
  fs.appendFileSync(config.stageFile, JSON.stringify(entry) + '\n');
  console.log(`[remote-projects-electron-probe] ${stage}`);
};
app.setPath('appData', path.join(config.root, 'app-data'));
app.setPath('userData', path.join(config.root, 'user-data'));
app.setPath('logs', path.join(config.root, 'logs'));
app.setPath('home', path.join(config.root, 'home'));
if (config.headless) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
}
record('electron-entry', { pid: process.pid, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, headless: config.headless });
app.on('will-finish-launching', () => record('will-finish-launching'));
app.on('ready', () => record('ready', { isolatedAppData: app.getPath('appData'), isolatedUserData: app.getPath('userData') }));
let complete = false;
let busy = false;
let inputStarted = false;
const windows = new Map();
const safe = value => typeof value === 'string' ? value.replace(/([?&](?:yuri_url_token|token|secret|key)=)[^&\s]+/gi, '$1[REDACTED]').replace(/(\/_file\/)[^/\s"'?]+\/[^/\s"'?]+/g, '$1[preview]/[url-auth]').replace(/\byuri_url_[A-Za-z0-9_-]{32}\b/g, '[URL_AUTH]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]') : value;
const diagnostic = (kind, detail) => fs.appendFileSync(path.join(config.root, 'ui-network-console.jsonl'), JSON.stringify({ epochMs: Date.now(), kind, ...detail }, (key, value) => /^(authorization|clientToken|password|secret|token|apiKey)$/i.test(key) ? '[REDACTED]' : safe(value)) + '\n');
const probeSource = 'if (!window.remoteProjectsPerformance) {\n' + fs.readFileSync(new URL('./browser-probe.js', import.meta.url), 'utf8') + '\n}\n' + `
;(() => {
  if (window.__remoteProjectsVisible) return;
  const marker = window.__remoteProjectsVisible = { sidebar: null, transcript: null };
  const visible = selector => [...document.querySelectorAll(selector)].some(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  });
  const sample = () => {
    if (!marker.sidebar && visible('[data-sidebar-project-header]')) marker.sidebar = Date.now();
    if (!marker.transcript && visible('[data-message-id]')) marker.transcript = Date.now();
  };
  const observe = () => { new MutationObserver(sample).observe(document.documentElement, {subtree:true, childList:true, attributes:true}); sample(); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', observe); else observe();
})();`;
app.on('web-contents-created', (_event, contents) => {
  record('web-contents-created', { id: contents.id });
  try {
    contents.debugger.attach('1.3');
    if (config.interactive) {
      const requests = new Map();
      void contents.debugger.sendCommand('Network.enable');
      void contents.debugger.sendCommand('Runtime.enable');
      contents.debugger.on('message', (_event, method, data) => {
        if (method === 'Network.requestWillBeSent') {
          try { const u = new URL(data.request.url); const route = u.origin + u.pathname; requests.set(data.requestId, route); diagnostic('request', { id: data.requestId, method: data.request.method, route }); } catch {}
        } else if (method === 'Network.responseReceived') diagnostic('response', { id: data.requestId, route: requests.get(data.requestId), status: data.response.status });
        else if (method === 'Network.loadingFailed') diagnostic('network-error', { id: data.requestId, route: requests.get(data.requestId), error: data.errorText, canceled: data.canceled });
        else if (method === 'Network.webSocketCreated') {
          const u = new URL(data.url); requests.set(data.requestId, u.origin + u.pathname);
          diagnostic('ws-created', { id: data.requestId, route: u.origin + u.pathname });
        } else if (method === 'Network.webSocketHandshakeResponseReceived') diagnostic('ws-handshake', { id: data.requestId, route: requests.get(data.requestId), status: data.response.status });
        else if (method === 'Network.webSocketFrameReceived') {
          const route = requests.get(data.requestId);
          if (route?.endsWith('/api/terminal/ws')) diagnostic('terminal-frame-received', { id: data.requestId, route, ...observeTerminalFrame(data.response) });
          else try { diagnostic('ws-received', { id: data.requestId, route, payload: JSON.parse(data.response.payloadData) }); } catch {}
        } else if (method === 'Network.webSocketFrameSent' && requests.get(data.requestId)?.endsWith('/api/terminal/ws')) {
          diagnostic('terminal-frame-sent', { id: data.requestId, route: requests.get(data.requestId), ...observeTerminalFrame(data.response) });
        } else if (method === 'Network.webSocketClosed') {
          diagnostic('ws-closed', { id: data.requestId, route: requests.get(data.requestId) });
        } else if (method === 'Network.webSocketFrameError') diagnostic('ws-error', { id: data.requestId, route: requests.get(data.requestId), error: data.errorMessage });
        else if (method === 'Runtime.exceptionThrown') diagnostic('exception', { text: data.exceptionDetails.exception?.description || data.exceptionDetails.text });
        else if (method === 'Runtime.consoleAPICalled') {
          const text = data.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
          diagnostic('console', { type: data.type, text: /secret|authorization|password|clientToken/i.test(text) ? '[credential-bearing console line redacted]' : text });
        }
      });
    }
    void contents.debugger.sendCommand('Page.enable').then(() => contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: probeSource })).catch(error => record('probe-inject-error', { error: error.message }));
  } catch (error) { record('debugger-attach-error', { error: error.message }); }
  contents.on('dom-ready', () => {
    void contents.executeJavaScript(probeSource).then(() => record('dom-probe-installed', { id: contents.id })).catch(error => record('dom-probe-failed', { error: error.message }));
  });
  contents.on('did-finish-load', () => record('did-finish-load', { id: contents.id, protocol: new URL(contents.getURL()).protocol }));
  contents.on('did-fail-load', (_event, code, description) => record('did-fail-load', { code, description }));
});

const finish = (status, detail = {}) => {
  if (complete) return;
  complete = true;
  const result = { schemaVersion: 1, status, startedAt, launchEpochMs: config.launchEpochMs,
    classification: config.classification ?? 'diagnostic', loadAverageAtLaunch: config.loadAverageAtLaunch,
    build: config.build, phase: config.phase, headless: config.headless, fixture: config.fixture, windows: [...windows.entries()], stages, ...detail };
  fs.writeFileSync(config.resultFile, JSON.stringify(result, null, 2) + '\n');
  record('probe-finished', { status });
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.exit(status === 'measured' ? 0 : 2);
};
const watchdog = setTimeout(() => finish('blocked', { reason: 'Full product startup/visible sidebar/transcript deadline exceeded. See actual stage log; no timing sample manufactured.' }), config.timeoutMs);
watchdog.unref();
const poll = setInterval(async () => {
  if (!app.isReady() || complete || busy) return;
  busy = true;
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      const wc = win.webContents;
      // executeJavaScript waits for did-finish-load; Runtime.evaluate does not.
      // Avoid charging asset completion/network wait to a sidebar already painted.
      const evaluated = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: `({markers:window.__remoteProjectsVisible??null,textareaCount:document.querySelectorAll('textarea').length,bodyLength:document.body?.textContent?.length??0,protocol:location.protocol})`,
        returnByValue: true,
      });
      const dom = evaluated.result.value;
      if (!dom) continue;
      const previous = windows.get(wc.id) ?? {};
      windows.set(wc.id, { ...previous, dom });
      for (const kind of ['sidebar', 'transcript']) {
        if (dom.markers?.[kind] && !previous[kind]) {
          // Capture actual compositor output, not just the DOM mutation timestamp.
          const image = await wc.capturePage();
          const screenshot = path.join(config.root, `${kind}.png`);
          fs.writeFileSync(screenshot, image.toPNG());
          previous[kind] = { domEpochMs: dom.markers[kind], captureCompletedEpochMs: Date.now(), screenshot, emptyImage: image.isEmpty() };
          windows.set(wc.id, { ...previous, dom });
          record(`${kind}-captured`, previous[kind]);
        }
      }
      if (previous.sidebar && previous.transcript) {
        if (config.input && !previous.input) {
          inputStarted = true;
          previous.input = await measureInput(wc);
          windows.set(wc.id, { ...previous, dom });
        }
        clearInterval(poll);
        if (config.interactive) {
          fs.writeFileSync(config.resultFile, JSON.stringify({ status: 'local-ready-for-functional-smoke', classification: 'diagnostic', windows: [...windows.entries()], stages }, null, 2));
          record('local-ready-for-functional-smoke');
          return;
        }
        finish('measured', { windows: [...windows.entries()], measurement: 'Process launch to compositor capture completed after real sidebar/transcript DOM visibility; conservative upper bound including screenshot/probe overhead, not first exact presentation timestamp.' });
        return;
      }
    }
  } catch (error) {
    record('observation-error', { error: error.message });
    if (inputStarted) { clearInterval(poll); finish('blocked', { reason: error.message }); }
  }
  finally { busy = false; }
}, 50);

if (config.interactive) {
  let lastId;
  let executing = false;
  const commands = setInterval(async () => {
    const file = path.join(config.root, 'control.json');
    if (complete || executing || !fs.existsSync(file)) return;
    const command = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (command.id === lastId) return;
    lastId = command.id; executing = true;
    const reply = { id: command.id, action: command.action, startedAt: Date.now() };
    try {
      const wc = BrowserWindow.getAllWindows().find(win => !win.isDestroyed())?.webContents;
      if (!wc) throw new Error('No real product window');
      if (['click', 'type', 'key', 'input'].includes(command.action)) {
        const window = wc.getOwnerBrowserWindow();
        window.show(); window.focus(); app.focus({ steal: true });
      }
      if (command.action === 'evaluate') reply.value = await wc.executeJavaScript(command.expression);
      else if (command.action === 'snapshot') reply.value = await wc.executeJavaScript(`({url:location.href,body:document.body.innerText.slice(0,20000),inputs:[...document.querySelectorAll('input,textarea')].map(n=>({tag:n.tagName,placeholder:n.placeholder,value:n.value,aria:n.getAttribute('aria-label')})),buttons:[...document.querySelectorAll('button')].filter(n=>n.getBoundingClientRect().height>0).map(n=>({text:n.innerText,aria:n.getAttribute('aria-label'),title:n.title}))})`);
      else if (command.action === 'click') {
        const point = await wc.executeJavaScript(`(() => {const candidates=[...document.querySelectorAll(${JSON.stringify(command.selector ?? 'button')})].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&${command.text ? `(n.innerText===${JSON.stringify(command.text)}||n.getAttribute('aria-label')===${JSON.stringify(command.text)}||n.title===${JSON.stringify(command.text)})` : 'true'}});if(candidates.length!==1)throw Error('Expected one visible click target; found '+candidates.length);const r=candidates[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        wc.sendInputEvent({ type: 'mouseMove', ...point });
        await new Promise(resolve => setTimeout(resolve, 100));
        wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
        reply.value = point;
      } else if (command.action === 'type') await wc.debugger.sendCommand('Input.insertText', { text: command.text });
      else if (command.action === 'choose-fixture-file') {
        const files = command.files;
        if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file).isFile())) throw new Error('Existing isolated fixture files required');
        const { root } = await wc.debugger.sendCommand('DOM.getDocument');
        const { nodeIds } = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: command.selector ?? 'input[type="file"]' });
        if (nodeIds.length !== 1) throw new Error('Exactly one real attachment file input required');
        await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[0], files });
        reply.value = { fixtureFilesSelected: files.length, method: 'Real product file input change; no direct upload request' };
      }
      else if (command.action === 'arm-file-chooser') {
        await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        reply.value = { realFileChooserInterceptedForFixtureSelection: true };
      }
      else if (command.action === 'observe-product-preview') {
        const visibleSource = await wc.executeJavaScript(`(()=>{const frames=[...document.querySelectorAll('iframe')].filter(n=>n.getBoundingClientRect().height>0&&n.src.includes('/_file/'));if(frames.length!==1)throw Error('Exactly one visible FilesView file-target preview required');return frames[0].src;})()`);
        const frames = wc.mainFrame.framesInSubtree.filter(frame => frame.url === visibleSource);
        if (frames.length !== 1) throw new Error('Actual product preview execution frame not uniquely resolved');
        reply.value = await frames[0].executeJavaScript(`(()=>{const image=n=>({loaded:Boolean(n?.complete&&n?.naturalWidth>0),width:n?.naturalWidth});const nested=document.querySelector('iframe');return {heading:document.querySelector('h1')?.innerText,graph:window.graph??null,color:getComputedStyle(document.body).color,fontSize:getComputedStyle(document.querySelector('h1')).fontSize,background:getComputedStyle(document.body).backgroundImage,picture:image(document.querySelector('#picture')),rootPicture:image(document.querySelector('#root-picture')),nested:{text:nested?.contentDocument?.body?.innerText,value:nested?.contentWindow?.nested,picture:image(nested?.contentDocument?.querySelector('img'))},resources:performance.getEntriesByType('resource').map(r=>({name:r.name,duration:r.duration}))};})()`);
        reply.value.observedFromActualProductIframe = true;
      }
      else if (command.action === 'key') {
        wc.sendInputEvent({ type: 'keyDown', keyCode: command.key, modifiers: command.modifiers ?? [] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: command.key, modifiers: command.modifiers ?? [] });
      } else if (command.action === 'screenshot') {
        if (!/^[a-zA-Z0-9-]+$/.test(command.name)) throw new Error('Unsafe image name');
        const image = await wc.capturePage();
        const target = path.join(config.root, `${command.name}.png`); fs.writeFileSync(target, image.toPNG()); reply.value = { file: target, empty: image.isEmpty() };
      } else if (command.action === 'input') reply.value = await measureInput(wc);
      else if (command.action === 'stop') { clearInterval(commands); finish('measured', { functionalSmoke: 'See control replies and real network/console evidence; no budget verdict.' }); return; }
      else throw new Error('Unknown product-control action');
      reply.status = 'completed';
    } catch (error) { reply.status = 'failed'; reply.error = error.message; }
    finally {
      reply.completedAt = Date.now();
      fs.appendFileSync(path.join(config.root, 'control-replies.jsonl'), JSON.stringify(reply, (_key, value) => safe(value)) + '\n');
      executing = false;
    }
  }, 100);
}

async function measureInput(wc) {
  await wc.executeJavaScript(`(() => {const targets=[...document.querySelectorAll('textarea')].filter(n=>n.getBoundingClientRect().height>0);if(targets.length!==1||targets[0].value)throw Error('Need exactly one visible empty real composer');targets[0].focus();remoteProjectsPerformance.reset();})()`);
  const results = {};
  const tracePath = path.join(config.root, 'input-trace.json');
  await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'blink.user_timing', 'input', 'latencyInfo', 'cc', 'toplevel'] });
  for (const scenario of ['typing', 'deletion', 'undo', 'paste', 'emulated-ime']) {
    const formats = scenario === 'paste' ? clipboard.availableFormats() : [];
    const supportedFormats = ['text/plain', 'text/html', 'text/rtf', 'image/png'];
    if (formats.some(format => !supportedFormats.includes(format))) {
      results.paste = { status: 'blocked', reason: 'Clipboard has formats that cannot be losslessly restored; user clipboard left untouched.' };
      continue;
    }
    let previousClipboard;
    if (scenario === 'paste') {
      previousClipboard = {
        ...(formats.includes('text/plain') ? { text: clipboard.readText() } : {}),
        ...(formats.includes('text/html') ? { html: clipboard.readHTML() } : {}),
        ...(formats.includes('text/rtf') ? { rtf: clipboard.readRTF() } : {}),
        ...(formats.includes('image/png') ? { image: clipboard.readImage() } : {}),
      };
      clipboard.writeText('fixture paste ');
    }
    await wc.executeJavaScript(`remoteProjectsPerformance.scenario(${JSON.stringify(scenario)})`);
    const correctness = [];
    try {
    for (let i = 0; i < 50; i++) {
      const before = await wc.executeJavaScript('document.activeElement.value.length');
      if (scenario === 'typing') {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'X' });
        wc.sendInputEvent({ type: 'char', keyCode: 'x' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'X' });
      }
      else if (scenario === 'deletion') { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' }); }
      else if (scenario === 'paste') wc.paste();
      else if (scenario === 'emulated-ime') {
        await wc.debugger.sendCommand('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
        await wc.debugger.sendCommand('Input.insertText', { text: '中' });
      }
      else {
        wc.sendInputEvent({ type: 'char', keyCode: 'u' });
        await wc.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))`);
        wc.undo();
      }
      await wc.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))`);
      const after = await wc.executeJavaScript(`(() => {const n=document.activeElement;return {length:n.value?.length,selectionStart:n.selectionStart,selectionEnd:n.selectionEnd,focused:n instanceof HTMLTextAreaElement}})()`);
      const expected = scenario === 'undo' ? before : scenario === 'deletion' ? before - 1 : scenario === 'paste' ? before + 'fixture paste '.length : before + 1;
      correctness.push({ beforeLength: before, expectedLength: expected, ...after });
      if (!after.focused || after.length !== expected || after.selectionStart !== after.selectionEnd) {
        fs.writeFileSync(path.join(config.root, `input-${scenario}-correctness.json`), JSON.stringify(correctness, null, 2));
        throw new Error(`${scenario} functional echo/caret/focus assertion failed at interaction ${i}; not a passing input sample`);
      }
    }
    results[scenario] = await wc.executeJavaScript('remoteProjectsPerformance.snapshot()');
    results[scenario].correctness = correctness;
    fs.writeFileSync(path.join(config.root, `input-${scenario}.json`), JSON.stringify(results[scenario], null, 2));
    await wc.executeJavaScript('remoteProjectsPerformance.reset()');
    } finally { if (previousClipboard) { clipboard.clear(); if (Object.keys(previousClipboard).length) clipboard.write(previousClipboard); } }
  }
  await contentTracing.stopRecording(tracePath);
  return { scenarios: results, tracePath, limitations: ['Baseline local full product only; no remote feature existed at HEAD.', 'emulated-ime exercises real Chromium composition via CDP, not the macOS Chinese input method/candidate window.', 'No five-way live model generation without a controlled inference upstream.', 'Synchronous dispatch excludes post-event microtasks; inspect the raw compositor/main-thread trace for complete P2 gate.'] };
}

record('import-full-product-main');
if (config.bootstrapLocalCredential) {
  const { createRemoteClientAuthRuntime } = await import(pathToFileURL(path.join(config.repo, 'packages/web/server/lib/client-auth/remote-clients.js')).href);
  const authority = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto,
    storePath: path.join(config.root, 'yuri-data/remote-clients.json') });
  const issued = await authority.createClient({ label: 'Isolated production desktop', clientKind: 'desktop-local', dedupeKey: 'isolated-production-desktop' });
  const file = path.join(config.root, 'yuri-data/settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...settings, desktopLocalClientToken: issued.token }), { mode: 0o600 });
  record('authoritative-local-grant-before-main', { credentialOmitted: true });
}
try { await import(pathToFileURL(path.join(config.repo, 'packages/electron/main.mjs')).href); record('full-product-main-imported'); }
catch (error) { record('main-import-failed', { error: error.stack ?? error.message }); finish('blocked', { reason: 'Unmodified Electron main import failed' }); }
