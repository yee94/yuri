import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const fixtures = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(fixtures, '../../.nsh/desktop-target');
const deps = path.join(target, 'debug/deps');
const candidates = (await readdir(deps)).filter(name => /^libserde_json-[\da-f]+\.rlib$/.test(name));
if (!process.env.SERDE_JSON_RLIB && candidates.length !== 1) throw new Error('Select an existing matching serde_json rlib with SERDE_JSON_RLIB; this fixture never installs dependencies');
const serde = process.env.SERDE_JSON_RLIB || path.join(deps, candidates[0]);
const installed = path.join(os.homedir(), '.cargo/bin/rustc');
const rustc = process.env.RUSTC || await access(installed).then(() => installed, () => 'rustc');
const binary = path.join(target, 'ssh-contract-tests');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 90_000, env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SSH fixture failed (${result.status ?? 'signal'})`);
}
run(rustc, ['--edition', '2024', '--test', '--crate-name', 'ssh_contract', path.join(fixtures, 'ssh-contract.rs'), '--extern', `serde_json=${serde}`, '-L', `dependency=${deps}`, '-o', binary]);
run(process.execPath, ['--check', path.join(fixtures, '../src/ssh_io_remote.cjs')]);
const temporary = process.env.OPENCODE_TMP_DIR || path.join(os.tmpdir(), 'opencode');
await mkdir(temporary, { recursive: true });
const fixtureRoot = await mkdtemp(path.join(temporary, 'nsh-ssh-io-'));
try {
  run(binary, ['--test-threads=1'], { ...process.env, NSH_SSH_IO_FIXTURE_ROOT: fixtureRoot, NSH_SSH_IO_NODE: process.execPath });
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
const processSource = await readFile(path.join(fixtures, '../src/ssh_process.rs'), 'utf8');
for (const name of ['INSPECT', 'BOOTSTRAP']) {
  const match = processSource.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`));
  if (!match) throw new Error(`Missing actual ${name} program`);
  const result = spawnSync(process.execPath, ['--check'], { input: match[1], encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} syntax check failed: ${result.stderr}`);
}
console.log('SSH synthetic transport + real temporary filesystem I/O; no real SSH, user config, Vault, Host or Windows runtime exercised.');
