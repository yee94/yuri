import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const steps = [];
const run = (file, args) => {
  const result = spawnSync(process.execPath, [`scripts/remote-projects/${file}.mjs`, ...args], { encoding: 'utf8', timeout: 120000 });
  steps.push({ file, action: args[0], exitCode: result.status, completedAt: Date.now() });
  if (result.status !== 0) throw new Error(`${file} ${args[0]} failed`);
  return result.stdout;
};
const record = { classification: 'native input functional diagnostic, not timing', steps };
const onscreen = process.argv[2] === 'onscreen';
const fixture = onscreen ? 'Q' : 'abc';
try {
  run('ios-accessibility', ['tap', 'Tap to type']);
  if (onscreen) run('ios-accessibility', ['tap', 'Q']);
  else run('ios-serve', ['type', fixture]);
  run('ios-device', ['screenshot', onscreen ? 'native-onscreen-input' : 'native-immediate-input']);
  const ax = JSON.parse(run('ios-accessibility', ['snapshot']));
  record.snapshotFile = ax.snapshotFile;
  record.fixtureVisibleInAx = ax.elements.some(e => /TextView|TextArea|TextField/.test(e.type) && e.value?.includes(fixture));
  record.status = record.fixtureVisibleInAx ? 'fixture-observed-in-ax' : 'fixture-not-observed-in-ax';
} catch (error) { record.status = 'blocked'; record.error = error.message; }
fs.writeFileSync(path.join(evidence, onscreen ? 'native-onscreen-input-smoke.json' : 'native-input-smoke.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
if (record.status !== 'fixture-observed-in-ax') process.exitCode = 2;
