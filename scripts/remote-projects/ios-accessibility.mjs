import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shownKeyboardFrame, systemKeyboardKey } from './ios-ax-runtime.mjs';

const run = args => {
  const result = spawnSync(process.execPath, ['scripts/remote-projects/ios-serve.mjs', ...args], { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error(`serve-sim ${args[0]} failed`);
  return result.stdout.trim();
};
const snapshot = JSON.parse(run(['ax']));
if (snapshot.status !== 200 || !Array.isArray(snapshot.body)) throw new Error('No usable native AX snapshot');
const elements = [];
const visit = element => { elements.push(element); for (const child of element.children ?? []) visit(child); };
snapshot.body.forEach(visit);
if (['tap', 'tap-prefix', 'tap-value', 'tap-button', 'long-press', 'tap-key'].includes(process.argv[2])) {
  const label = process.argv.slice(3).join(' ');
  let matches = elements.filter(element => (process.argv[2] !== 'tap-button' || element.type === 'Button') && (process.argv[2] === 'tap-prefix' ? element.AXLabel?.startsWith(label) : process.argv[2] === 'tap-value' ? element.AXValue === label : element.AXLabel === label) && element.enabled !== false && element.frame?.width > 0);
  if (process.argv[2] === 'tap-key') {
    const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
    const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json')));
    const container = spawnSync('xcrun', ['simctl', 'get_app_container', state.udid, state.bundleId, 'data'], { env: { ...process.env, DEVELOPER_DIR: state.developerDir }, encoding: 'utf8' });
    if (container.status !== 0 || !container.stdout.includes(state.udid)) throw new Error('Wrong task App sandbox');
    const events = fs.readFileSync(path.join(container.stdout.trim(), 'tmp/input-native-events-v2.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    matches = [systemKeyboardKey(elements, shownKeyboardFrame(events), label)];
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one enabled AX target; found ${matches.length}`);
  const app = snapshot.body[0].frame;
  const rect = matches[0].frame;
  const x = (rect.x + rect.width / 2 - app.x) / app.width;
  const y = (rect.y + rect.height / 2 - app.y) / app.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) throw new Error('AX target is offscreen');
  if (process.argv[2] === 'long-press') {
    run(['gesture', JSON.stringify({ type: 'begin', x, y })]);
    await new Promise(resolve => setTimeout(resolve, 750));
    run(['gesture', JSON.stringify({ type: 'end', x, y })]);
  } else run(['tap', String(x), String(y)]);
  console.log(JSON.stringify({ action: process.argv[2], label, x, y, snapshotFile: snapshot.file }));
} else if (process.argv[2] === 'snapshot') {
  console.log(JSON.stringify({ snapshotFile: snapshot.file, elements: elements.filter(e => e.AXLabel || e.AXValue).map(e => ({ type: e.type, label: e.AXLabel, value: e.AXValue, frame: e.frame })) }, null, 2));
} else throw new Error('Usage: ios-accessibility.mjs snapshot | tap EXACT_AX_LABEL | tap-prefix UNIQUE_AX_LABEL_PREFIX');
