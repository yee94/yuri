import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const stages = [];
const run = args => {
  const start = Date.now();
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000 });
  stages.push({ command: 'node', args, startedAt: start, completedAt: Date.now(), exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  fs.writeFileSync(path.join(evidence, 'native-smoke.json'), JSON.stringify({ classification: 'diagnostic', stages }, null, 2));
  if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr}`);
};
run(['scripts/remote-projects/ios-device.mjs', 'install']);
run(['scripts/remote-projects/ios-device.mjs', 'launch']);
for (const [index, wait] of [0, 500, 1500, 3000].entries()) {
  if (wait) await delay(wait);
  run(['scripts/remote-projects/ios-device.mjs', 'screenshot', `initial-frame-${index}`]);
}
run(['scripts/remote-projects/ios-serve.mjs', 'start']);
