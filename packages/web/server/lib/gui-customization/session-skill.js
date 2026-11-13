import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { remoteConnectionsCommand } from './remote-connections-client.mjs';
import { sessionSkillCommand } from './session-skill-command.mjs';

const scripts = { 'remote-connections.mjs': './remote-connections-client.mjs', 'projects.mjs': './projects-client.mjs', 'session-skill-command.mjs': './session-skill-command.mjs' };
const files = ['SKILL.md', 'references/projects.md', 'references/appearance.md', 'references/ui-surfaces.md', 'references/plugin-styles.md', 'references/gui-api.md', 'references/workflow.md', 'references/global-pages.md', 'references/work-status.md', 'references/icons.md', 'references/file-previews.md', 'references/preview-exports.md', 'references/remote-connections.md', ...Object.keys(scripts)];

/** Stage immutable, shipped instructions; never edit the user's global skills/config. */
export function createCustomizationSkillInstaller({ yuriDataDir }) {
  const resources = new Map();
  const prepare = (withRemote, withProjects) => {
    const key = `${withRemote}:${withProjects}`;
    if (!resources.has(key)) resources.set(key, (async () => {
      const stagedFiles = files.filter((name) => (name !== 'remote-connections.mjs' || withRemote)
        && (name !== 'projects.mjs' || withProjects) && (name !== 'session-skill-command.mjs' || withRemote || withProjects));
      const contents = await Promise.all(stagedFiles.map((name) => readFile(new URL(scripts[name] ?? `./skill/${name}`, import.meta.url), 'utf8')));
      const hash = createHash('sha256').update(contents.join('\0')).digest('hex').slice(0, 16);
      const directory = path.join(yuriDataDir, 'session-skills', `yuri-customization-${hash}`);
      await mkdir(path.join(directory, 'references'), { recursive: true, mode: 0o700 });
      await Promise.all(stagedFiles.map(async (name, index) => {
        const target = path.join(directory, name);
        const temporary = `${target}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, contents[index], { mode: 0o600 }); await rename(temporary, target); }
        finally { await rm(temporary, { force: true }); }
      }));
      return path.join(directory, 'SKILL.md');
    })().catch((error) => { resources.delete(key); throw error; }));
    return resources.get(key);
  };
  return async (client, sessionID, { remoteBinding, projectBinding } = {}) => {
    const file = await prepare(Boolean(remoteBinding), Boolean(projectBinding));
    const projects = projectBinding ? ` For local/remote project registration, discovering authorized remote machines, or reading/creating/continuing remote sessions, read references/projects.md and run the bound project API helper.\nBound project helper: ${sessionSkillCommand(process.execPath, path.join(path.dirname(file), 'projects.mjs'), Buffer.from(JSON.stringify({ ...projectBinding, sessionID })).toString('base64url'), 'describe')}\n` : ' No bound project helper is provided; project registration and remote project/session access are unavailable through this session skill.';
    const remote = remoteBinding ? ` For SSH setup/config sync or Relay pairing, use only this bound helper after reading references/remote-connections.md. Bound local desktop helper: ${remoteConnectionsCommand(process.execPath, path.join(path.dirname(file), 'remote-connections.mjs'), Buffer.from(JSON.stringify({ ...remoteBinding, sessionID })).toString('base64url'), 'describe')}` : ' No bound SSH/Relay command is provided: these operations are unavailable in this session. Report that limit and stop this branch; use native Settings or a new supported local desktop session. A script or another capability\'s binding does not enable it. There is no credential/filesystem fallback for this capability.';
    await client.session.instructions.entry.put({ sessionID, key: 'yuri.customization',
      value: `Yuri customization: for adding a directory as a project in Yuri (local or remote), remote sessions, SSH connections, configuration sync, Relay pairing, appearance (themes, CSS/layout, Logo, macOS Dock), work-status widgets, global pages/tabs, custom file parsing/previews, preview exports, or GUI panels/commands/settings, read ${JSON.stringify(file)} first. Use the matching reference and apply changes only when requested.${projects}${remote}`,
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
