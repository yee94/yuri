import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { experimentOverride, methods, validateGrants } from './build.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
it('keeps the production entry and default OFF byte-for-byte; only an explicit isolated artifact changes the single experiment seam', () => {
  const source = readFileSync(path.join(root, '../../application.tsx'), 'utf8');
  expect(experimentOverride(source, false)).toBe(source);
  expect(experimentOverride(source, true).replace('const footerExperiment = signal(true);', 'const footerExperiment = signal(false);')).toBe(source);
  expect(() => experimentOverride('no recognized seam', true)).toThrow();
  const sidecar = readFileSync(path.join(root, 'sidecar.ts'), 'utf8');
  expect(sidecar).not.toMatch(/\bmount\(|createChat|createNativeHistory|setTimeout|setInterval|scrollTo|contentOffset|contentInset/);
});
it('grants only exact memory/native-appearance/clock calls, never a production transport or capability wildcard', () => {
  expect(() => validateGrants({ host: methods })).not.toThrow();
  expect(() => validateGrants({ host: [...methods, '*'] })).toThrow();
  expect(() => validateGrants({ host: methods, clipboard: true })).toThrow();
  expect(methods).not.toContain('connection.connect'); expect(methods).not.toContain('speech.segment');
});
