import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));
const cli = process.env.NSH_BIN || "nsh";

test("native engine opens a real TSX chat and sends through the native boundary", () => {
  const steps = [
    'await app.waitFor("text:Native conversation");',
    'await app.press("text:Native conversation");',
    'await app.waitFor("text:Hello from the native engine");',
    'await app.waitFor("text:Native test model");',
    'expect(app.texts()).not.toContain("Yuri");',
    'await app.type("id:composer", "Hello native Yuri with fifty characters of input now");',
    'await app.press("id:send");',
    'await app.waitFor("text:Message accepted by native transport");',
    'expect(app.value("id:composer")).toBe("");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected request|Invalid active membership/);',
  ].join("\n");
  const result = spawnSync(
    cli,
    ["test", "App.tsx", "--web-host", "tests/host.js"],
    { cwd: directory, input: steps, encoding: "utf8", timeout: 45_000 },
  );
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);

test('native model picker restores model, thinking variant and Agent from the authoritative selection', () => {
  const steps = [
    'await app.waitFor("text:Native conversation");',
    'await app.press("text:Native conversation");',
    'await app.waitFor("text:Native test model");',
    'await app.press("id:chat-selection");',
    'await app.waitFor("text:Second native model");',
    'expect(app.texts()).not.toContain("Hidden subagent");',
    'await app.type("id:model-search", "Second");',
    'await app.press("id:model-fixture-second-model");',
    'await app.waitFor("id:composer");',
    'await app.waitFor("text:Second native model");',
    'await app.press("id:chat-selection");',
    'await app.waitFor("id:model-variant-fixture-second-model");',
    'await app.press("id:model-provider-group-fixture >> id:model-variant-fixture-second-model");',
    'await app.press("id:model-provider-group-fixture >> id:model-effort-fixture-second-model-high");',
    'await app.waitFor("id:chat-selection");',
    'await app.waitFor("text:High");',
    'await app.press("id:chat-agent-selection");',
    'await app.waitFor("label:Plan");',
    'expect(app.shows("id:model-agent-plan")).toBe(false);',
    'await app.longPress("id:chat-agent-selection");',
    'await app.waitFor("text:Plan");',
    'expect(app.texts()).not.toContain("Hidden subagent");',
    'expect(app.shows("id:model-search")).toBe(false);',
    'await app.press("id:model-agent-build");',
    'await app.waitFor("id:chat-selection");',
    'await app.waitFor("label:build");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected request|HTTP 4/);',
  ].join('\n');
  const result = spawnSync(cli, ['test', 'App.tsx', '--web-host', 'tests/host.js'], { cwd: directory, input: steps, encoding: 'utf8', timeout: 45_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
