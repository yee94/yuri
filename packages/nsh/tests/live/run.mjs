import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run from anywhere. No token is passed in argv, output, or repository files.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const child = spawn('bunx', ['--package', 'vitest@4.1.11', 'vitest', 'run', '--config', 'packages/nsh/vitest.config.ts', 'packages/nsh/live.test.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, NSH_LIVE: '1' },
});
child.on('error', () => { console.error('Cannot start live acceptance runner'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
