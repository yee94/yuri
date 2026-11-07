import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const voiceProductionCapabilities = [
  'connection.list', 'connection.select', 'runtime.request', 'runtime.stream', 'runtime.stop',
  'appearance.reset', 'appearance.apply', 'notification.configure', 'native.diagnostics.status',
  'speech.prepare', 'speech.segment', 'speech.stop', 'speech.release',
  'voiceRecognition.capabilities', 'voiceRecognition.start', 'voiceRecognition.finish', 'voiceRecognition.cancel',
];

/** Real production App entry; no replacement UI, initial Tab/route or state seed.
 * Production config/Storage and .nsh output are never overwritten. */
export function withVoiceProductionFixture(root, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-settings-voice-production-'));
  try {
    const entry = 'App.tsx', host = path.join(directory, 'host.js');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Voice production synthetic fixture', id: 'example.yuri.voice-production.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: voiceProductionCapabilities } }));
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['*.ts', '*.tsx'] }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    const built = spawnSync('bun', ['build', 'tests/settings-voice-production-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error('Voice production strict Host static bundle failed: ' + built.stdout + built.stderr);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
