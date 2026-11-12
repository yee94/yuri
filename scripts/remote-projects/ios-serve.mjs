import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { readHelperAx } from './ios-ax-runtime.mjs';

const action = process.argv[2];
const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json'), 'utf8'));
const binary = path.join(state.repo, 'packages/mobile/node_modules/.bin/serve-sim');
const helperTmp = path.join(state.root, 'helper-tmp');
fs.mkdirSync(helperTmp, { recursive: true });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: helperTmp, DEVELOPER_DIR: state.developerDir };
const sanitize = value => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|authorization|password/i.test(key)).map(([key, v]) => [key, sanitize(v)]));
  if (typeof value === 'string') return value.replace(/([?&](?:token|secret|key)=)[^&\s]+/gi, '$1[REDACTED]');
  return value;
};
const run = args => {
  const startedAt = Date.now();
  const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 120000 });
  let output;
  try { output = sanitize(JSON.parse(result.stdout)); } catch { output = undefined; }
  const record = { command: 'serve-sim', args: action === 'type' ? ['type', '[fixture text omitted]', '-d', state.udid] : args,
    startedAt, durationMs: Date.now() - startedAt, exitCode: result.status, output,
    limitation: 'CLI acknowledgement is not UIKit input handling, painting, or interaction latency' };
  fs.appendFileSync(path.join(evidence, 'serve-commands.jsonl'), JSON.stringify(record) + '\n');
  if (result.status !== 0) throw new Error(`serve-sim ${action} failed: ${String(result.stderr).replace(/token[^\s]*/gi, '[REDACTED]')}`);
  if (output) console.log(JSON.stringify(output));
  return output;
};
if (action === 'start') {
  const existing = path.join(helperTmp, 'serve-sim', `server-${state.udid}.json`);
  if (fs.existsSync(existing)) {
    const old = JSON.parse(fs.readFileSync(existing, 'utf8'));
    try { process.kill(old.pid, 0); console.log(JSON.stringify(sanitize(old))); process.exit(0); } catch {}
  }
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const output = run(['--detach', '-q', '--host', '127.0.0.1', '--port', String(port), state.udid]);
  fs.writeFileSync(path.join(evidence, 'serve.json'), JSON.stringify(output, null, 2) + '\n');
} else if (action === 'ax') {
  const helper = JSON.parse(fs.readFileSync(path.join(helperTmp, 'serve-sim', `server-${state.udid}.json`), 'utf8'));
  if (helper.device !== state.udid) throw new Error('Helper does not belong to this task device');
  const { body, durationMs } = await readHelperAx({ helper, root: state.root });
  const file = path.join(evidence, `ax-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  console.log(JSON.stringify({ status: 200, file, body, durationMs }));
} else if (action === 'tap') run(['tap', process.argv[3], process.argv[4], '-d', state.udid]);
else if (action === 'gesture') {
  const gesture = JSON.parse(process.argv[3]);
  if (!['begin', 'move', 'end'].includes(gesture.type) || !Number.isFinite(gesture.x) || !Number.isFinite(gesture.y) || gesture.x < 0 || gesture.x > 1 || gesture.y < 0 || gesture.y > 1) throw new Error('Bounded task touch gesture required');
  run(['gesture', JSON.stringify(gesture), '-d', state.udid]);
}
else if (action === 'type') run(['type', process.argv.slice(3).join(' '), '-d', state.udid]);
else if (action === 'home') run(['button', 'home', '-d', state.udid]);
else if (action === 'stop') run(['--kill', state.udid, '-q']);
else throw new Error('Usage: ios-serve.mjs start|ax|tap x y|type text|home|stop');
