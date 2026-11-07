import { spawnSync } from 'node:child_process';
const result = spawnSync(process.env.NSH_BIN || 'nsh', process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
