import { readFileSync } from 'node:fs';
import { checkSyncCapture, type SyncCapture } from './sync-verdict';

const [file, manifestFile] = process.argv.slice(2);
if (!file || !manifestFile) throw new Error('Usage: bun packages/nsh/tests/history-terminal/check-sync-capture.ts captures.json build/manifest.json [--release]');
const data = JSON.parse(readFileSync(file, 'utf8')) as SyncCapture;
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { executableSHA256: string; bundleSHA256: string };
const result = checkSyncCapture(data, manifest.executableSHA256, manifest.bundleSHA256);
console.log(JSON.stringify(result, null, 2));
const selected = process.argv.includes('--release') ? result.releases : result.commits;
process.exitCode = selected.length && selected.every(item => item.verdict === 'within-continuous-native-window') ? 0 : 1;
