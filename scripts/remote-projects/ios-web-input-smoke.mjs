import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const run = (script, args) => {
  const r = spawnSync(process.execPath, [`scripts/remote-projects/${script}.mjs`, ...args], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`${script} ${args[0]} failed`);
  return r.stdout;
};
const flatten = nodes => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
const samples = [];
const record = { classification: 'functional diagnostic: default Web composer inside real Capacitor App, not UIKit timing', samples };
try {
  for (let i = 1; i <= 50; i++) {
    run('ios-serve', ['type', 'x']);
    const ax = JSON.parse(run('ios-serve', ['ax']));
    const expected = 'x'.repeat(i);
    const entry = flatten(ax.body).find(n => /TextArea|TextView|TextField/.test(n.type) && n.AXValue === expected);
    samples.push({ index: i, expectedLength: i, observed: Boolean(entry), snapshotFile: ax.file });
    fs.writeFileSync(path.join(evidence, 'web-input-50.json'), JSON.stringify(record, null, 2));
    if (!entry) throw new Error(`Real AX echo missing at event ${i}`);
  }
  record.status = '50-functional-echoes-observed';
} catch (error) { record.status = 'failed'; record.error = error.message; process.exitCode = 2; }
fs.writeFileSync(path.join(evidence, 'web-input-50.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
