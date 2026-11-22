import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { remoteConnectionsCommand } from './remote-connections-client.mjs';
import { sessionSkillCommand } from './session-skill-command.mjs';

const scripts = { 'remote-connections.mjs': './remote-connections-client.mjs', 'projects.mjs': './projects-client.mjs', 'session-skill-command.mjs': './session-skill-command.mjs' };
const files = ['SKILL.md', 'references/projects.md', 'references/history-import.md', 'references/appearance.md', 'references/ui-surfaces.md', 'references/plugin-styles.md', 'references/gui-api.md', 'references/workflow.md', 'references/global-pages.md', 'references/work-status.md', 'references/icons.md', 'references/file-previews.md', 'references/preview-exports.md', 'references/remote-connections.md', 'references/deep-links.md', ...Object.keys(scripts)];

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
  /** Stage the resource set and format the bound helper commands for one caller (`{sessionID}` or `{assistantID}`). */
  const resolve = async (caller, { remoteBinding, projectBinding } = {}) => {
    const file = await prepare(Boolean(remoteBinding), Boolean(projectBinding));
    const encode = (binding) => Buffer.from(JSON.stringify({ ...binding, ...caller })).toString('base64url');
    return {
      file,
      projectsCommand: projectBinding ? sessionSkillCommand(process.execPath, path.join(path.dirname(file), 'projects.mjs'), encode(projectBinding), 'describe') : null,
      remoteCommand: remoteBinding ? remoteConnectionsCommand(process.execPath, path.join(path.dirname(file), 'remote-connections.mjs'), encode(remoteBinding), 'describe') : null,
    };
  };
  const install = async (client, sessionID, { remoteBinding, projectBinding } = {}) => {
    const { file, projectsCommand, remoteCommand } = await resolve({ sessionID }, { remoteBinding, projectBinding });
    const projects = projectsCommand ? `\nBound project helper: ${projectsCommand}\n` : ' No bound project helper is provided.';
    const remote = remoteCommand ? ` Bound local desktop helper: ${remoteCommand}` : ' No bound SSH/Relay command is provided.';
    await client.session.instructions.entry.put({ sessionID, key: 'yuri.customization',
      value: `Yuri customization covers project management, task and session lifecycle (archive, settled; local and remote sessions), session import, remote hosts and sessions, resource identity and yuri:// deep links, SSH, configuration sync, Relay pairing and GUI customization. For these capabilities, read ${JSON.stringify(file)} first, then load only the matching reference.${projects}${remote}`,
    });
  };
  install.resolve = resolve;
  return install;
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
