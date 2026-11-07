import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = 'packages/ui/src/assets/provider-logos/wafer.ai.svg';
const output = 'packages/nsh/assets/provider-logos/wafer.ai.png';
const manifest = 'packages/nsh/assets/provider-logos/wafer.ai.generated.json';
const svg = await readFile(path.join(root, source));
const match = svg.toString('utf8').match(/^<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink">\s*<image width="24" height="24" xlink:href="data:image\/png;base64,([A-Za-z0-9+/]+={0,2})"\/>\s*<\/svg>\s*$/);
if (!match) throw new Error('Review Wafer native artwork: expected only the original full-viewport PNG wrapper');
const png = Buffer.from(match[1], 'base64');
if (png.toString('base64') !== match[1] || png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('Invalid embedded Wafer PNG');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.stringify({
  schemaVersion: 1,
  generator: 'packages/nsh/scripts/generate-provider-raster.mjs',
  source, sourceSha256: digest(svg),
  output, outputSha256: digest(png), bytes: png.length,
  pixelWidth: png.readUInt32BE(16), pixelHeight: png.readUInt32BE(20),
  svgViewport: [24, 24],
}, null, 2) + '\n';
if (!process.argv.includes('--check')) await mkdir(path.dirname(path.join(root, output)), { recursive: true });
for (const [file, contents] of [[output, png], [manifest, Buffer.from(metadata)]]) {
  if (process.argv.includes('--check')) {
    if (!(await readFile(path.join(root, file))).equals(contents)) throw new Error(`Native provider artwork is stale: ${file}`);
  } else await writeFile(path.join(root, file), contents);
}
console.log(`Native Wafer artwork: ${png.length} original PNG bytes, SHA-256 ${digest(png)}`);
