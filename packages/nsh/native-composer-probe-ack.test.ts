import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error The isolated fixture builder is plain ESM.
import { prepareProbeSources } from './tests/native-composer-spellcheck/build-probe.mjs';

it.skipIf(process.env.NSH_COMPOSER_PROBE_ENGINE !== '1')('real synthetic probe: visible revision must reach and validate the actual JS host handler ACK without clearing Input', async () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'opencode', 'composer-probe-ack-'));
  try {
    const prepared = await prepareProbeSources(output);
    const entry = prepared.entry;
    const driver = path.join(prepared.source, 'probe-ack.test.tsx');
    writeFileSync(driver, [
      'import { expect, open, test } from "nsh/test";',
      'test("exact probe ACK", async () => {',
      `const app = await open(${JSON.stringify(entry)}, { platform: "macos", storage: {}, network: {}, host: { params: { composerReadbackEnabled: true }, handlers: { "fixture.composer.hostAdopted": data => { if (Object.keys(data).length !== 1 || typeof data.revision !== "number") throw new Error("invalid probe payload"); return {accepted:true,revision:data.revision}; } } } });`,
      'try {',
      'await app.waitFor("id:composer");',
      'await app.type("id:composer", "retained synthetic draft");',
      'await app.host.send("fixture.composer.hostChanged", {revision:1});',
      'await app.waitFor("text:Synthetic Host revision 1");',
      'await app.wait(100);',
      'expect(app.host.calls().length).toBe(1);',
      'expect(app.texts()).toContain("ACK accepted revision:1 code:none");',
      'expect(app.value("id:composer")).toBe("retained synthetic draft");',
      'await app.host.send("fixture.composer.hostChanged", {revision:2});',
      'await app.waitFor("text:ACK accepted revision:2 code:none");',
      'expect(app.host.calls().length).toBe(2);',
      'expect(app.value("id:composer")).toBe("retained synthetic draft");',
      '} finally { app.dispose(); }',
      '});',
    ].join('\n'));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver], { cwd: prepared.cwd, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 90_000);

it.skipIf(process.env.NSH_COMPOSER_PROBE_ENGINE !== '1').each([
  { name: 'denied grant', deny: true, response: '{accepted:true,revision:data.revision}', code: 'ack_access_denied', calls: 0 },
  { name: 'wrong reply revision', deny: false, response: '{accepted:true,revision:99}', code: 'ack_reply_invalid', calls: 1 },
  { name: 'native rejection', deny: false, response: '{accepted:false,revision:data.revision}', code: 'ack_reply_rejected', calls: 1 },
])('real synthetic probe reports bounded metadata for $name, without fabricating adoption', async scenario => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'opencode', 'composer-probe-ack-failure-'));
  try {
    const prepared = await prepareProbeSources(output);
    if (scenario.deny) writeFileSync(path.join(prepared.source, 'nsh.json'), JSON.stringify({ name: 'Denied probe', id: 'example.nsh.composer-probe.denied', capabilities: { host: [] } }));
    const driver = path.join(prepared.source, 'probe-failure.test.tsx');
    writeFileSync(driver, [
      'import { expect, open, test } from "nsh/test";',
      'test("bounded probe ACK failure", async () => {',
      `const app = await open(${JSON.stringify(prepared.entry)}, { platform: "macos", storage: {}, network: {}, host: { params: { composerReadbackEnabled: true }, handlers: { "fixture.composer.hostAdopted": data => (${scenario.response}) } } });`,
      'try {',
      'await app.waitFor("id:composer");',
      'await app.host.send("fixture.composer.hostChanged", {revision:1});',
      `await app.waitFor(${JSON.stringify(`text:ACK ${scenario.code === 'ack_reply_rejected' ? 'rejected' : 'failed'} revision:1 code:${scenario.code}`)});`,
      'expect(app.texts()).toContain("Synthetic Host revision 1");',
      `expect(app.host.calls().length).toBe(${scenario.calls});`,
      '} finally { app.dispose(); }',
      '});',
    ].join('\n'));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver], { cwd: prepared.cwd, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain('unhandled rejection');
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 90_000);
