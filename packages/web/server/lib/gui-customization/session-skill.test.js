import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createCustomizationSkillInstaller, registerCustomizationSessionSkill } from './session-skill.js';

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-customization-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
describe('built-in customization instructions', () => {
  it('stages a complete skill and references and installs only a short session-scoped pointer', async () => {
    const root = await directory();
    const put = vi.fn(); const client = { session: { instructions: { entry: { put } } } };
    const install = createCustomizationSkillInstaller({ yuriDataDir: root });
    await install(client, 'ses_one'); await install(client, 'ses_two');
    const entry = put.mock.calls[0][0];
    expect(entry).toMatchObject({ sessionID: 'ses_one', key: 'yuri.customization' });
    expect(entry.value.length).toBeLessThan(1500);
    const file = JSON.parse(entry.value.match(/read (".*?") first/)[1]);
    expect(await fs.readFile(file, 'utf8')).toContain('name: yuri-customization');
    for (const name of ['appearance', 'ui-surfaces', 'plugin-styles', 'gui-api', 'workflow', 'global-pages', 'work-status', 'icons', 'file-previews', 'preview-exports', 'remote-connections']) expect((await fs.readFile(path.join(path.dirname(file), 'references', `${name}.md`), 'utf8')).length).toBeGreaterThan(500);
    expect(entry.value).not.toContain('Bound local desktop helper');
    expect(entry.value).toContain('No bound SSH/Relay command is provided');
    expect(entry.value).toContain('There is no credential/filesystem fallback');
    await expect(fs.stat(path.join(path.dirname(file), 'remote-connections.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(file, 'utf8')).toContain('(references/icons.md)');
    expect(await fs.readFile(path.join(path.dirname(file), 'references', 'global-pages.md'), 'utf8')).toContain('(icons.md)');
    expect(await fs.readFile(path.join(path.dirname(file), 'references', 'appearance.md'), 'utf8')).toContain('yuri.branding');
    expect(put.mock.calls[1][0].value).toBe(entry.value);
    await install(client, 'ses_bound', { hostOrigin: 'http://127.0.0.1:4000', upstreamOrigin: 'http://127.0.0.1:4096', registrationFile: path.join(root, 'service.json') });
    const bound = put.mock.calls[2][0].value;
    const boundFile = JSON.parse(bound.match(/read (".*?") first/)[1]);
    expect(boundFile).not.toBe(file);
    expect(bound).toContain('Bound local desktop helper:');
    expect(await fs.readFile(path.join(path.dirname(boundFile), 'remote-connections.mjs'), 'utf8')).toContain('/api/yuri/session-skills/remote-connections');
  });
  it('initializes managed sessions, rolls back failures, preserves adopted sessions and skips external/shared ownership', async () => {
    const root = await directory();
    let external = false, shared = false, failed = false;
    const client = { session: {
      create: vi.fn(async (body) => ({ ...body, id: body.id ?? 'ses_new' })), remove: vi.fn(),
      instructions: { entry: { put: vi.fn(async () => { if (failed) throw new Error('unavailable'); }) } },
    } };
    const app = express();
    registerCustomizationSessionSkill(app, { express, yuriDataDir: root, getIsExternalOpenCode: () => external, getIsSharedOpenCodeService: () => shared, waitForOpenCodeReady: async () => {}, createClient: () => client });
    app.post('/api/session', (_, res) => res.status(202).json({ delegated: true }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanup.unshift(() => new Promise((resolve) => server.close(resolve)));
    const request = (body = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await (await request({ title: 'Keep' })).json()).data.title).toBe('Keep');
    expect(client.session.instructions.entry.put).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_new', key: 'yuri.customization' }));
    failed = true; expect((await request()).status).toBe(503);
    expect(client.session.remove).toHaveBeenCalledExactlyOnceWith({ sessionID: 'ses_new' });
    expect((await (await request({ id: 'ses_existing' })).json()).sessionID).toBe('ses_existing');
    expect(client.session.remove).toHaveBeenCalledTimes(1);
    external = true; expect((await request()).status).toBe(202);
    external = false; shared = true; expect((await request()).status).toBe(202);
    expect(client.session.create).toHaveBeenCalledTimes(3);
  });
});
