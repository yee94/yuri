import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const run = (script, ...args) => {
  const result = spawnSync(process.execPath, [`scripts/remote-projects/${script}.mjs`, ...args], { encoding: 'utf8', timeout: 180000 });
  if (result.status !== 0) throw new Error(`${script} ${args[0]} failed`);
};
const prefix = process.argv[2] ?? 'fixture-input';
if (!/^[a-zA-Z0-9-]+$/.test(prefix)) throw new Error('Unsafe screenshot prefix');
run('ios-serve', 'ax');
run('ios-device', 'screenshot', `${prefix}-before-background`);
run('ios-serve', 'home');
await delay(2000);
run('ios-serve', 'ax');
run('ios-device', 'screenshot', 'background-home');
run('ios-device', 'foreground');
await delay(2000);
run('ios-serve', 'ax');
run('ios-device', 'screenshot', `${prefix}-after-foreground`);
console.log('Diagnostic background/foreground command sequence completed; inspect AX and images, not command latency.');
