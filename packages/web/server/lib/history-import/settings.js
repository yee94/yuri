import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'jsonc-parser';
import { readConfigLayers, writeConfig } from '../opencode/config-files.js';
import { digest, fail } from './events.js';
import { resolveImportDirectory } from './targets.js';

const MAX_RULE_BYTES = 512 * 1024;
const roots = { claude: ['CLAUDE.md', '.claude/rules', '.claude/skills'], codex: ['AGENTS.md', '.agents/skills', '.codex/skills'],
  cursor: ['.cursorrules', '.cursor/rules', '.cursor/skills'], dsh: ['AGENTS.md', '.agents/skills', '.dsh/skills'] };

async function readOptional(file) {
  try { const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_settings_path');
    if (stat.size > MAX_RULE_BYTES) fail('settings_too_large');
    return await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function* ruleFiles(base, relative, depth = 0) {
  if (depth > 8) fail('settings_too_large');
  const file = path.join(base, relative); let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) fail('unsafe_settings_path');
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(file)) yield* ruleFiles(base, path.join(relative, entry), depth + 1);
  } else if (stat.isFile() && (/\.(?:md|mdc)$/i.test(relative) || path.basename(relative) === '.cursorrules')) yield relative;
}

// Destination writes cannot follow symlinks out of the approved project. The
// same check runs at preview and immediately before each write.
async function targetPath(directory, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) fail('unsafe_settings_path');
  const real = await resolveImportDirectory(directory, true);
  if (real !== directory) fail('target_changed');
  let current = real;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('unsafe_settings_path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

export async function planSettings(source, sourceDirectory, directory) {
  if (!path.isAbsolute(sourceDirectory)) return [];
  let sourceRoot;
  try { sourceRoot = await fs.realpath(sourceDirectory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const root of roots[source]) {
    for await (const relative of ruleFiles(sourceRoot, root)) {
      if (result.length >= 200) fail('settings_too_large');
      const content = await readOptional(path.join(sourceRoot, relative));
      const skill = /(?:^|[/\\])skills[/\\]/.test(relative);
      // Never load supporting scripts/config files as executable capabilities.
      if (skill && path.basename(relative) !== 'SKILL.md') continue;
      const scope = path.dirname(relative);
      const target = skill ? path.join('.opencode', 'skills', `imported-${source}-${digest(`${sourceRoot}:${scope}`).slice(0, 12)}`, 'SKILL.md')
        : path.join('.opencode', 'imported-rules', `${source}-${digest(`${sourceRoot}:${relative}`).slice(0, 16)}.md`);
      const destination = await targetPath(directory, target);
      const existing = await readOptional(destination);
      // OpenCode already discovers a root AGENTS.md/CLAUDE.md in-place.
      const native = sourceRoot === directory && ['AGENTS.md', 'CLAUDE.md'].includes(relative);
      const scoped = /\b(?:globs|paths|alwaysApply)\s*:/.test(content);
      const activated = !skill && !native && !scoped;
      result.push({ key: digest(`${directory}:${sourceRoot}:${source}:${relative}`), source, sourceDirectory: sourceRoot, relative,
        directory, target, kind: skill ? 'skill' : 'rule', content, hash: digest(content),
        beforeHash: existing === null ? null : digest(existing), status: native || existing === content ? 'unchanged' : existing === null ? 'create' : 'conflict',
        activated, scoped });
    }
  }
  return result;
}

async function configSnapshot(directory) {
  const candidates = ['opencode.json', 'opencode.jsonc', path.join('.opencode', 'opencode.json'), path.join('.opencode', 'opencode.jsonc')];
  let file = await targetPath(directory, path.join('.opencode', 'opencode.jsonc')); let text = null;
  for (const relative of candidates) {
    const candidate = await targetPath(directory, relative); const content = await readOptional(candidate);
    if (content !== null) { file = candidate; text = content; }
  }
  const errors = []; const config = text === null ? {} : parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, allowEmptyContent: true }) ?? {};
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)
    || config.instructions !== undefined && (!Array.isArray(config.instructions) || config.instructions.some((entry) => typeof entry !== 'string'))) fail('invalid_target_config');
  // Preserve effective inherited instructions, not only the touched document.
  const layers = readConfigLayers(directory);
  const instructions = layers.mergedConfig.instructions ?? [];
  if (!Array.isArray(instructions) || instructions.some((entry) => typeof entry !== 'string')) fail('invalid_target_config');
  const hash = digest({ file, text, instructions });
  return { file, config, instructions, hash };
}

export async function settingsConfigFingerprint(directory) { return (await configSnapshot(directory)).hash; }

export async function applySettings(item, decision, configHash) {
  if (!['keep', 'replace', 'copy'].includes(decision)) fail('invalid_selection');
  if (item.status === 'unchanged' || item.status === 'conflict' && decision === 'keep') return { status: 'skipped' };
  const sourceText = await readOptional(path.join(item.sourceDirectory, item.relative));
  if (sourceText === null || digest(sourceText) !== item.hash) fail('source_changed');
  let relative = item.target;
  if (item.status === 'conflict' && decision === 'copy') {
    relative = item.kind === 'skill' ? path.join(path.dirname(path.dirname(item.target)), `${path.basename(path.dirname(item.target))}-${item.hash.slice(0, 8)}`, 'SKILL.md')
      : item.target.replace(/\.md$/, `-${item.hash.slice(0, 8)}.md`);
  }
  const destination = await targetPath(item.directory, relative);
  const before = await readOptional(destination);
  const expected = relative === item.target ? item.beforeHash : null;
  if (before !== null && digest(before) === item.hash) return { status: 'skipped' };
  if ((before === null ? null : digest(before)) !== expected) fail('target_changed');
  const snapshot = item.activated ? await configSnapshot(item.directory) : null;
  if (snapshot && snapshot.hash !== configHash) fail('target_changed');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  // Recheck ancestors after mkdir and before creating the exclusive new file.
  await targetPath(item.directory, relative);
  let backup;
  if (before !== null) {
    backup = `${destination}.yuri-${digest(before).slice(0, 12)}.backup`;
    try { await fs.writeFile(backup, before, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, item.content, { flag: 'wx', mode: 0o600 });
    // Do not overwrite a file changed since preview or while preparing the write.
    const current = await readOptional(destination);
    if ((current === null ? null : digest(current)) !== expected) fail('target_changed');
    if (before === null) { await fs.link(temporary, destination); await fs.unlink(temporary); }
    else await fs.rename(temporary, destination);
    if (snapshot) {
      const fresh = await configSnapshot(item.directory);
      if (fresh.hash !== configHash) fail('target_changed');
      const instruction = relative.split(path.sep).join('/');
      writeConfig({ ...fresh.config, instructions: [...new Set([...fresh.instructions, instruction])] }, fresh.file);
    }
  } catch (error) {
    // Compensate only our own unchanged content. Never erase a concurrent edit.
    const current = await readOptional(destination);
    if (current !== null && digest(current) === item.hash) {
      if (before === null) await fs.unlink(destination);
      else await fs.writeFile(destination, before, { mode: 0o600 });
    }
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
  return { status: 'imported', configHash: item.activated ? await settingsConfigFingerprint(item.directory) : configHash, backup: Boolean(backup) };
}
