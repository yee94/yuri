import { spawnSync } from 'node:child_process';
import { ensureNSHCompatibilityTools, prepareNSHCompatibility } from './nsh-compat.mjs';
const prepared = await prepareNSHCompatibility();
const tools = await ensureNSHCompatibilityTools(prepared);
const result = spawnSync(tools.bin, process.argv.slice(2), { stdio: 'inherit', env: tools.env, windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
