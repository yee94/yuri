import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('one native backspace removes a whole reference and leaves the caret before the untouched suffix', () => {
  const target = process.env.NSH_INLINE_DELETE_TARGET;
  const steps = ['await app.waitFor("id:atomic-input");'];
  if (!target) steps.push('await app.press("id:without-suffix");');
  for (const kind of ['skill', 'file', 'directory', 'agent', 'session']) steps.push(
    `await app.press("id:seed-${kind}");`,
    `await app.waitUntil(() => app.value("id:atomic-input") === ${JSON.stringify(target ? '前 @review 后' : '前 @review')});`,
    'await app.press("id:place-caret");',
    'await app.keyboard.press("backspace");',
    `await app.waitUntil(() => app.value("id:atomic-input") === ${JSON.stringify(target ? '前  后' : '前 ')});`,
    'expect(app.texts()).toContain("refs:0");',
    'await app.keyboard.press("x");',
    `expect(app.value("id:atomic-input")).toBe(${JSON.stringify(target ? '前 x 后' : '前 x')});`,
  );
  steps.push('await app.press("id:seed-composing");', 'await app.press("id:place-caret");', 'await app.keyboard.press("backspace");',
    `expect(app.value("id:atomic-input")).toBe(${JSON.stringify(target ? '前 @revie 后' : '前 @revie')});`);
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'composer-inline-delete-fixture.tsx', ...(target ? ['--target', target] : [])], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 90_000, input: steps.join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);
