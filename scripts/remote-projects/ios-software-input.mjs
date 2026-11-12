import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readHelperAx, shownKeyboardFrame, systemKeyboardKey } from './ios-ax-runtime.mjs';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const [label, fieldLabel, textFile] = process.argv.slice(2);
const resumePrefix = process.argv.includes('--resume-prefix');
if (!/^[a-zA-Z0-9-]+$/.test(label ?? '') || !fieldLabel || !textFile) throw new Error('Usage: LABEL EXACT_AX_FIELD FIXTURE_TEXT_FILE');
const text = fs.readFileSync(textFile, 'utf8');
if (!text || text.length > 300 || !/^[a-zA-Z0-9/ .-]+$/.test(text)) throw new Error('Only bounded isolated ASCII fixture input is supported');
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json')));
const helper = JSON.parse(fs.readFileSync(path.join(state.root, 'helper-tmp/serve-sim', `server-${state.udid}.json`)));
if (helper.device !== state.udid) throw new Error('Wrong task helper');
const container = spawnSync('xcrun', ['simctl', 'get_app_container', state.udid, state.bundleId, 'data'], { env: { ...process.env, DEVELOPER_DIR: state.developerDir }, encoding: 'utf8' });
if (container.status !== 0 || !container.stdout.includes(state.udid)) throw new Error('Task App sandbox unavailable');
const eventFile = path.join(container.stdout.trim(), 'tmp/input-native-events-v2.jsonl');
const keyboardFrame = () => {
  if (!fs.existsSync(eventFile)) throw new Error('Install the observational native keyboard probe before software typing');
  return shownKeyboardFrame(fs.readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
};
const output = path.join(evidence, `software-input-${label}.json`);
if (fs.existsSync(output)) throw new Error('Refusing software input evidence overwrite');
const report = { label, fieldLabel, expectedLength: text.length, steps: [], startedAt: Date.now(), method: 'Actual fresh AX system-keyboard touch only; no CLI type, DOM draft or value writes' };
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
const snapshot = async () => {
  const ax = await readHelperAx({ helper, root: state.root });
  report.lastAxDurationMs = ax.durationMs; save(); return ax;
};
const tap = async (ax, key) => {
  const frame = keyboardFrame();
  const n = systemKeyboardKey(ax.elements, frame, key), x = (n.frame.x + n.frame.width / 2 - ax.app.x) / ax.app.width, y = (n.frame.y + n.frame.height / 2 - ax.app.y) / ax.app.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) throw new Error('System key offscreen');
  const r = spawnSync(process.execPath, ['scripts/remote-projects/ios-serve.mjs', 'tap', String(x), String(y)], { encoding: 'utf8', timeout: 30000 });
  report.steps.push({ key, x, y, keyboardFrame: frame, epochMs: Date.now(), exitCode: r.status }); save();
  if (r.status !== 0) throw new Error('Software key touch failed');
  await delay(120);
};
const field = ax => {
  const matches = ax.elements.filter(n => n.AXLabel === fieldLabel && /TextField|TextArea|TextView/.test(n.type));
  if (matches.length !== 1) throw new Error('Unique actual AX text field required');
  return matches[0];
};
try {
  let ax = await snapshot();
  const initial = String(field(ax).AXValue ?? '').trim();
  if (initial && (!resumePrefix || !text.startsWith(initial))) throw new Error('Fixture field must initially be empty or an explicitly resumed exact fixture prefix');
  const probeLabel = `software-preflight-${label}`;
  const probe = spawnSync(process.execPath, ['scripts/remote-projects/ios-input-probe.mjs', probeLabel], { env: { ...process.env, REMOTE_PROJECTS_IOS_EVIDENCE: evidence }, encoding: 'utf8', timeout: 60000 });
  if (probe.status !== 0) throw new Error('Read-only focused caret preflight failed');
  const active = JSON.parse(fs.readFileSync(path.join(evidence, `probe-${probeLabel}.json`))).web?.active;
  report.caretPreflight = active; save();
  if (active?.aria !== fieldLabel || active.valueLength !== initial.length || active.start !== initial.length || active.end !== initial.length) throw new Error('Actual focused caret is not at the fixture prefix end; refusing software input without changing selection');
  report.resumedPrefixLength = initial.length;
  for (let index = initial.length; index < text.length; index++) {
    ax = await snapshot();
    const char = text[index], key = char === ' ' ? ' ' : char;
    if (!systemKeyboardKey(ax.elements, keyboardFrame(), key, true)) {
      const toggle = /[a-z]/i.test(char) ? (systemKeyboardKey(ax.elements, keyboardFrame(), 'letters', true) ? 'letters' : 'shift') : 'numbers';
      await tap(ax, toggle); ax = await snapshot();
      if (/[a-z]/i.test(char) && !systemKeyboardKey(ax.elements, keyboardFrame(), key, true)) { await tap(ax, 'shift'); ax = await snapshot(); }
    }
    await tap(ax, key);
    ax = await snapshot();
    const actual = String(field(ax).AXValue ?? '');
    report.observedLength = actual.length; save();
    if (actual !== text.slice(0, index + 1)) { report.mismatch = { expectedPrefix: text.slice(0, index + 1), actualFixtureText: actual }; throw new Error(`AX text mismatch after software key ${index + 1}`); }
  }
  report.status = 'passed-actual-ax-text';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 2; }
report.completedAt = Date.now(); save();
console.log(JSON.stringify({ label, status: report.status, expectedLength: report.expectedLength, observedLength: report.observedLength, error: report.error }));
