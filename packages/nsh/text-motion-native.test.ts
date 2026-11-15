import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));

it('production text motions preserve formatted durations and land on the latest burst update in the NSH engine', () => {
  const ios = process.env.NSH_TEXT_MOTION_IOS === '1';
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'text-motion-fixture.tsx', ...(ios ? ['--target', 'ios'] : [])], {
    cwd: directory, encoding: 'utf8', timeout: 100_000, input: [
      'await app.waitFor("id:motion-shimmer");',
      'expect(app.texts()).toContain("Thinking · 正在思考");',
      'expect(app.texts()).toContain("9.9s");',
      ...(ios ? [
        'await app.wait(400);',
        'await app.screenshot(".nsh/text-motion-sweep-1.png");',
        'await app.wait(280);',
        'await app.screenshot(".nsh/text-motion-sweep-2.png");',
        'await app.wait(280);',
        'await app.screenshot(".nsh/text-motion-sweep-3.png");',
        'await app.press("id:motion-dark");',
        'await app.wait(120);',
        'await app.screenshot(".nsh/text-motion-dark-1.png");',
        'await app.wait(280);',
        'await app.screenshot(".nsh/text-motion-dark-2.png");',
        'await app.wait(280);',
        'await app.screenshot(".nsh/text-motion-dark-3.png");',
        'await app.press("id:motion-delayed");',
        'await app.wait(620);',
        'await app.screenshot(".nsh/text-motion-delayed-1.png");',
        'await app.wait(90);',
        'await app.screenshot(".nsh/text-motion-delayed-2.png");',
        'await app.wait(90);',
        'await app.screenshot(".nsh/text-motion-delayed-3.png");',
      ] : []),
      'await app.press("id:motion-ten");',
      'await app.wait(400);',
      'expect(app.texts()).toContain("10.0s");',
      'await app.press("id:motion-minute");',
      'await app.wait(400);',
      'expect(app.texts()).toContain("1m 0s");',
      'await app.press("id:motion-shrink");',
      'await app.wait(400);',
      'expect(app.texts()).toContain("9.9s");',
      'await app.press("id:motion-summary");',
      'await app.press("id:motion-burst");',
      'await app.wait(1000);',
      'expect(app.texts()).toContain("Read 5 files");',
      'expect(app.texts()).not.toContain("Read 2 files");',
      'await app.press("id:motion-ten");',
      'await app.press("id:motion-stop");',
      'await app.wait(400);',
      'expect(app.texts()).toContain("10.0s");',
      'expect(app.texts()).toContain("Thinking · 正在思考");',
      ...(ios ? ['await app.screenshot(".nsh/text-motion-ios.png");'] : []),
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 115_000);
