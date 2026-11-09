import { runSettingsEngineFixture } from './tests/settings-engine-fixture-runner.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function nativeTest(steps: string[]) {
    const result = runSettingsEngineFixture(directory, 'settings-provider-removal-test-app.tsx', 'tests/settings-provider-removal-host.js', steps, 35_000);
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
}
const open = (scope: string, id: string) => [
  `await app.waitFor("id:provider-fixture-${scope}");`, `await app.press("id:provider-fixture-${scope}");`,
  `await app.waitFor("text:Fixture ${id}");`, `await app.press("text:Fixture ${id}");`,
  'await app.waitFor("text:Fixture model");',
];
const confirm = 'app.onDialog(dialog => dialog.buttons.includes("Delete") ? "Delete" : null);';

test.each(['global', 'scoped'])('provider deletion confirms shared impact, cancel writes nothing and authority refreshes the parent (%s)', scope => {
  nativeTest([
    ...open(scope, 'target'),
    'await app.waitUntil(() => app.enabled("id:settings-provider-delete"));',
    'app.onDialog(() => "Cancel");', 'await app.press("id:settings-provider-delete");',
    'expect(app.dialogs().at(-1).message).toContain("also affects other projects");',
    'expect(app.texts().includes("Fixture model")).toBe(true);',
    confirm, 'await app.press("id:settings-provider-delete");',
    'await app.waitFor("text:Verified removal: target");',
    'expect(app.texts().includes("Fixture target")).toBe(false);',
  ]);
}, 75_000);

test.each(['partial-config', 'partial-credential'])('provider %s failure stays in detail and safely resumes without repeated ACKs', id => {
  nativeTest([
    ...open('scoped', id), 'await app.waitUntil(() => app.enabled("id:settings-provider-delete"));', confirm, 'await app.press("id:settings-provider-delete");',
    'await app.waitFor("text:Could not finish deleting this provider. Some changes may already be applied; retry to finish.");',
    'expect(app.texts().includes("Fixture model")).toBe(true);',
    'await app.press("id:settings-provider-delete");', `await app.waitFor("text:Verified removal: ${id}");`,
    'expect(app.dialogs().length).toBe(1);',
  ]);
}, 75_000);

test('failed authoritative provider refresh keeps detail and retries reads, not deletion', () => {
  nativeTest([
    ...open('scoped', 'refresh'), 'await app.waitUntil(() => app.enabled("id:settings-provider-delete"));', confirm, 'await app.press("id:settings-provider-delete");',
    'await app.waitFor("id:settings-provider-delete-metadata-retry");',
    'expect(app.texts().includes("Fixture model")).toBe(true);',
    'await app.press("id:settings-provider-delete-metadata-retry");', 'await app.waitUntil(() => app.enabled("id:settings-provider-delete"));',
    'await app.press("id:settings-provider-delete");', 'await app.waitFor("text:Verified removal: refresh");',
  ]);
}, 75_000);

test.each(['environment', 'runtime'])('provider %s source is read-only for destructive removal', id => {
  nativeTest([
    ...open('global', id), `await app.waitFor("text:${id === 'environment' ? 'Remove the corresponding environment variables and restart OpenCode. To only hide models, use “Remove all” below.' : 'Disable this provider in its plugin or runtime configuration. To only hide models, use “Remove all” below.'}");`,
    'expect(app.enabled("id:settings-provider-delete")).toBe(false);', 'expect(app.dialogs().length).toBe(0);',
    'expect(app.texts().includes("Fixture model")).toBe(true);',
  ]);
}, 75_000);
