import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const files = ['SKILL.md', 'references/appearance.md', 'references/ui-surfaces.md', 'references/plugin-styles.md', 'references/gui-api.md', 'references/workflow.md', 'references/global-pages.md', 'references/work-status.md', 'references/icons.md', 'references/file-previews.md', 'references/preview-exports.md'];

/** Stage immutable, shipped instructions; never edit the user's global skills/config. */
export function createCustomizationSkillInstaller({ yuriDataDir }) {
  let resources;
  const prepare = () => {
    resources ??= (async () => {
      const contents = await Promise.all(files.map((name) => readFile(new URL(`./skill/${name}`, import.meta.url), 'utf8')));
      const hash = createHash('sha256').update(contents.join('\0')).digest('hex').slice(0, 16);
      const directory = path.join(yuriDataDir, 'session-skills', `yuri-customization-${hash}`);
      await mkdir(path.join(directory, 'references'), { recursive: true, mode: 0o700 });
      await Promise.all(files.map(async (name, index) => {
        const target = path.join(directory, name);
        const temporary = `${target}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, contents[index], { mode: 0o600 }); await rename(temporary, target); }
        finally { await rm(temporary, { force: true }); }
      }));
      return path.join(directory, 'SKILL.md');
    })().catch((error) => { resources = undefined; throw error; });
    return resources;
  };
  return async (client, sessionID) => {
    const file = await prepare();
    await client.session.instructions.entry.put({ sessionID, key: 'yuri.customization',
      value: `Yuri customization: for appearance (themes, CSS/layout, Logo, macOS Dock), work-status widgets, global pages/tabs, custom file parsing/previews, preview exports, or GUI panels/commands/settings, read ${JSON.stringify(file)} before choosing a plugin API. Its style/icon references guide plugin-owned content; UI structure maps built-in blocks, selectors and transparency layers; capability references cover contracts and runtime limits. Use its workflow for building, installation and rollback. Install or apply changes only when requested.`,
    });
  };
}

/** Managed local servers share the resource filesystem; external servers do not. */
export function registerCustomizationSessionSkill(app, { express, yuriDataDir, getIsSharedOpenCodeService, getIsExternalOpenCode, waitForOpenCodeReady, createClient }) {
  const install = createCustomizationSkillInstaller({ yuriDataDir });
  app.post('/api/session', express.json({ limit: '1mb' }), async (req, res, next) => {
    if (getIsSharedOpenCodeService() || getIsExternalOpenCode()) return next();
    const body = req.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Session input must be an object' });
    let client, created;
    try {
      await waitForOpenCodeReady();
      client = createClient();
      created = await client.session.create(body);
      if (!created?.id) throw new Error('Session creation was not confirmed');
      await install(client, created.id);
      return res.json({ data: created });
    } catch {
      let retainedSessionID = created?.id;
      if (created?.id && !body.id) {
        try { await client.session.remove({ sessionID: created.id }); retainedSessionID = undefined; }
        catch { /* Preserve the ID when rollback cannot be confirmed. */ }
      }
      return res.status(503).json({ code: 'session_skill_initialization_failed', error: 'New session capability initialization failed', ...(retainedSessionID ? { sessionID: retainedSessionID } : {}) });
    }
  });
}
