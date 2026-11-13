import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ownerNodeVisible } from './performance-owner-visibility.mjs';

const toolsRoot = fileURLToPath(new URL('./', import.meta.url));
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = path.resolve(option('out'));
if (fs.existsSync(output)) throw new Error('Refusing to overwrite cold-start evidence');
fs.mkdirSync(output, { recursive: true });
if (!process.argv.includes('--confirm-owner-window-released')) throw new Error('Explicit task-owner measurement handoff required');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error(`Measurement anchor changed: ${before}`);
  return source.replace(before, after);
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/performance-owner-cold-'));
let entry = fs.readFileSync(path.join(toolsRoot, 'electron-production-entry.mjs'), 'utf8');
entry = replace(entry, `    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';`, `    return (${ownerNodeVisible.toString()})(node, document);`);
entry = replace(entry, `attributes:true}); sample();`, `attributes:true}); setInterval(sample, 50); sample();`);
entry = replace(entry, `        if (config.input && !previous.input) {`, `        if (config.input && !previous.input) {
          await wc.debugger.sendCommand('Page.stopScreencast');`);
entry = replace(entry, `finish('measured', { windows: [...windows.entries()], measurement:`, `await new Promise(resolve => setTimeout(resolve, 500));
        finish('measured', { ownerPixelReview: 'required; driver measured status is not a paint/budget pass', windows: [...windows.entries()], measurement:`);
entry = replace(entry, "contents.debugger.attach('1.3');", `contents.debugger.attach('1.3');
    let ownerFrame = 0; let ownerBytes = 0;
    contents.debugger.on('message', (_event, method, data) => {
      if (method !== 'Page.screencastFrame') return;
      const bytes = Buffer.from(data.data, 'base64'); ownerBytes += bytes.length;
      const filename = 'owner-frame-' + contents.id + '-' + String(ownerFrame++).padStart(5, '0') + '.jpg';
      if (ownerBytes <= 80 * 1024 * 1024 && ownerFrame <= 500) {
        fs.writeFileSync(path.join(config.root, filename), bytes);
        fs.appendFileSync(path.join(config.root, 'owner-frames.jsonl'), JSON.stringify({
          filename, windowId: contents.id, ordinal: ownerFrame - 1,
          frameSwapEpochMs: data.metadata.timestamp === undefined ? null : data.metadata.timestamp * 1000,
          frameSwapMonotonicUs: data.metadata.monotonicTimestamp === undefined ? null : data.metadata.monotonicTimestamp * 1e6,
          observedEpochMs: Date.now(), metadata: data.metadata, bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        }) + '\\n');
      } else record('owner-frame-capacity-exceeded', { ownerFrame, ownerBytes });
      void contents.debugger.sendCommand('Page.screencastFrameAck', { sessionId: data.sessionId }).catch(error => record('owner-frame-ack-error', { error: error.message }));
    });
    void contents.debugger.sendCommand('Page.enable').then(() => contents.debugger.sendCommand('Page.startScreencast', {
      format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1,
    })).catch(error => record('owner-frame-start-error', { error: error.message }));`);
const entryFile = path.join(temporary, 'owner-entry.mjs'); fs.writeFileSync(entryFile, entry);
let driver = fs.readFileSync(path.join(toolsRoot, 'electron-production.mjs'), 'utf8');
driver = replace(driver, "from './seeded-opencode.mjs'", `from '${pathToFileURL(path.join(toolsRoot, 'seeded-opencode.mjs')).href}'`);
driver = replace(driver, "fileURLToPath(new URL('./electron-production-entry.mjs', import.meta.url))", JSON.stringify(entryFile));
for (const name of ['browser-probe.js', 'terminal-frame-observer.mjs']) {
  driver = driver.replaceAll(`new URL('./${name}', import.meta.url)`, `new URL(${JSON.stringify(pathToFileURL(path.join(toolsRoot, name)).href)})`);
}
driver = replace(driver, "const probeSource = fs.readFileSync(new URL(", "const originalProbeSource = fs.readFileSync(new URL(");
driver = replace(driver, 'const runs = [];', `const probeSource = Buffer.from(originalProbeSource.toString().replace('start: performance.now(), scenario,', 'start: performance.now(), eventTimeStamp: e.timeStamp, scenario,'));\nconst runs = [];`);
const driverFile = path.join(temporary, 'owner-driver.mjs'); fs.writeFileSync(driverFile, driver);
fs.writeFileSync(path.join(output, 'owner-entry.mjs.txt'), entry);
fs.writeFileSync(path.join(output, 'owner-driver.mjs.txt'), driver);
fs.writeFileSync(path.join(output, 'owner-instrumentation.json'), JSON.stringify({
  entrySha256: sha(entry), driverSha256: sha(driver), sourceDriverSha256: sha(fs.readFileSync(path.join(toolsRoot, 'electron-production.mjs'))),
  sourceEntrySha256: sha(fs.readFileSync(path.join(toolsRoot, 'electron-production-entry.mjs'))),
  unchangedProductMain: true, measurement: 'Actual CDP compositor frame pixels and frame-swap timestamp; callback time, DOM and rAF are not paint timestamps',
  caveat: 'Screencast may skip frames; semantic first-visibility review must provide bounds, not assume first received frame equals first paint. Frame swap is not physical display presentation.',
  argv: process.argv,
}, null, 2));
const args = process.argv.slice(2).filter(arg => arg !== '--confirm-owner-window-released');
const log = fs.openSync(path.join(output, 'driver.log'), 'wx');
const child = spawn(process.execPath, [driverFile, ...args], { stdio: ['ignore', log, log] });
const code = await new Promise(resolve => child.once('exit', code => resolve(code ?? 1))); fs.closeSync(log);
const runsFile = path.join(output, 'runs.json');
if (fs.existsSync(runsFile)) {
  const document = JSON.parse(fs.readFileSync(runsFile, 'utf8')); const manifest = [];
  for (const run of document.runs) {
    const root = path.join(document.isolatedRoot, `cold-${run.index}`); const destination = path.join(output, 'artifacts', `cold-${run.index}`);
    fs.mkdirSync(destination, { recursive: true });
    for (const filename of fs.readdirSync(root)) {
      if (!/^owner-frame-\d+-\d+\.jpg$|^owner-frames\.jsonl$|^(sidebar|transcript)\.png$/.test(filename)) continue;
      const bytes = fs.readFileSync(path.join(root, filename)); fs.writeFileSync(path.join(destination, filename), bytes);
      manifest.push({ path: path.relative(output, path.join(destination, filename)), bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  fs.writeFileSync(path.join(output, 'frame-artifacts.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(output, 'owner-validity.json'), JSON.stringify({
    status: 'pending-pixel-review', budgetPassed: false,
    reason: 'DOM occlusion guard is prerequisite only; reviewed frame pixels and frame-swap bounds are required.',
    runs: document.runs.length,
  }, null, 2));
}
fs.rmSync(temporary, { recursive: true, force: true });
process.exitCode = code;
