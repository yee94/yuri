import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json'), 'utf8'));
const prefix = process.argv[2] ?? 'native';
if (!/^[a-zA-Z0-9-]+$/.test(prefix)) throw new Error('Unsafe console evidence prefix');
const child = spawn('xcrun', ['simctl', 'launch', '--terminate-running-process', '--console', state.udid, state.bundleId],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME, DEVELOPER_DIR: state.developerDir }, stdio: ['ignore', 'pipe', 'pipe'] });
// Retain fixed diagnostic markers only: Capacitor may log bridge arguments,
// including the issued credential. Never save or echo raw console output.
for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => {
  const markers = ['secure:write failed', 'secure:read failed', 'secure:write', 'UNIMPLEMENTED', 'not implemented', '-34018', 'internalSetItem', 'Missing entitlement', 'KeychainSwift', 'AparajitaCapacitorSecureStorage', 'TypeError', 'ReferenceError', 'YuriComposer present', 'YuriComposer setState', 'YuriComposer focus', 'YuriComposer hide', 'YuriComposer show'].filter(marker => line.includes(marker));
  if (markers.length) fs.appendFileSync(path.join(evidence, `${prefix}-console-markers.jsonl`), JSON.stringify({ epochMs: Date.now(), markers }) + '\n');
});
const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => child.kill(signal));
child.once('exit', code => { clearTimeout(timer); console.log(JSON.stringify({ exitCode: code, rawConsoleRetained: false })); });
