import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const waferSvg = 'packages/ui/src/assets/provider-logos/wafer.ai.svg';
const waferPng = 'packages/nsh/assets/provider-logos/wafer.ai.png';

test('native provider logo graph excludes the unsupported Wafer SVG image wrapper', () => {
  // The shared Web asset intentionally keeps the original embedded artwork.
  expect(readFileSync(path.join(root, waferSvg), 'utf8')).toMatch(/<image\s[^>]*xlink:href="data:image\/png;base64,/);
  const directory = mkdtempSync(path.join(tmpdir(), 'opencode/nsh-provider-logo-'));
  try {
    const metafile = path.join(directory, 'graph.json');
    const result = spawnSync('bun', ['build', 'packages/nsh/chat-header-provider-logo.tsx', 'packages/nsh/provider-logo.tsx', '--target=browser', '--tree-shaking=false', '--external=nsh', '--external=nsh/*', `--outdir=${directory}`, `--metafile=${metafile}`], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const inputs = Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs);
    expect(inputs, 'NSH cannot draw the <image> embedded in this SVG').not.toContain(waferSvg);
    expect(inputs).toContain(waferPng);
    expect(inputs.some(file => file.includes('generate-provider-raster'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native Wafer raster is byte-identical to the original embedded PNG, with reproducible provenance', () => {
  const svg = readFileSync(path.join(root, waferSvg));
  const embedded = Buffer.from(svg.toString('utf8').match(/base64,([A-Za-z0-9+/=]+)"/)![1], 'base64');
  const png = readFileSync(path.join(root, waferPng));
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  expect(png.equals(embedded)).toBe(true);
  expect(digest(png)).toBe('0ea3f1cc96d0771be732e822a5844a0972c3f29eb68db96e54ee5d2238659050');
  expect(JSON.parse(readFileSync(path.join(root, 'packages/nsh/assets/provider-logos/wafer.ai.generated.json'), 'utf8'))).toEqual({
    schemaVersion: 1, generator: 'packages/nsh/scripts/generate-provider-raster.mjs',
    source: waferSvg, sourceSha256: digest(svg), output: waferPng, outputSha256: digest(png),
    bytes: 2004, pixelWidth: 93, pixelHeight: 92, svgViewport: [24, 24],
  });
  const check = spawnSync(process.execPath, ['packages/nsh/scripts/generate-provider-raster.mjs', '--check'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  expect(check.status, check.stdout + check.stderr).toBe(0);
});
