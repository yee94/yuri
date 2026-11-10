import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const commands = { claude: ['claude'], codex: ['codex'], cursor: ['cursor', 'cursor-agent'], dsh: ['dsh'] };

// Installation evidence is an executable/app binary, never a leftover history
// directory. Probes do not launch source agents or read their configuration.
export async function detectSourceInstallations(sources = Object.keys(commands), { home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const paths = [...new Set([...(env.PATH || '').split(windows ? ';' : path.delimiter).filter(Boolean),
    path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.npm-global', 'bin')])];
  const extensions = windows ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  return Object.fromEntries(await Promise.all(sources.map(async (source) => {
    if (!commands[source]) return [source, null];
    const candidates = paths.flatMap((directory) => commands[source].flatMap((command) => extensions.map((extension) => path.join(directory, `${command}${extension}`))));
    if (source === 'claude') candidates.push(path.join(home, '.claude', 'local', 'claude'));
    if (platform === 'darwin' && ['cursor', 'codex'].includes(source)) {
      const name = source === 'cursor' ? 'Cursor' : 'Codex';
      for (const applications of ['/Applications', path.join(home, 'Applications')]) candidates.push(path.join(applications, `${name}.app`, 'Contents', 'MacOS', name));
    }
    if (windows && source === 'cursor') {
      if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe'));
      if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'Cursor', 'Cursor.exe'));
    }
    let unknown = false;
    for (const candidate of candidates) {
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, windows ? constants.F_OK : constants.X_OK);
        return [source, true];
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) unknown = true;
      }
    }
    return [source, unknown ? null : false];
  })));
}
