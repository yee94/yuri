import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { applySettings, planSettings, settingsConfigFingerprint } from './settings.js';

let temporary; let source; let target;
const save = async (base, relative, content) => { const file = path.join(base, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file; };
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-import-settings-'));
  temporary = await fs.realpath(temporary);
  source = path.join(temporary, 'source'); target = path.join(temporary, 'target');
  await fs.mkdir(source); await fs.mkdir(target);
  vi.stubEnv('OPENCODE_CONFIG_DIR', path.join(temporary, 'config')); vi.stubEnv('OPENCODE_CONFIG', '');
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(temporary, { recursive: true, force: true }); });

test('merges text rules through the existing JSONC owner, preserves inherited instructions/comments and leaves sources untouched', async () => {
  const original = '# Project rules\nPreserve types.\n';
  await save(source, 'CLAUDE.md', original);
  await save(target, 'opencode.json', '{"instructions":["base.md"]}');
  await save(target, '.opencode/opencode.jsonc', '{\n // keep this comment\n "model": "example/model",\n}');
  const [item] = await planSettings('claude', source, target);
  const result = await applySettings(item, 'keep', await settingsConfigFingerprint(target));
  expect(result.status).toBe('imported');
  const text = await fs.readFile(path.join(target, '.opencode/opencode.jsonc'), 'utf8');
  expect(text).toContain('// keep this comment');
  expect(parse(text)).toMatchObject({ model: 'example/model', instructions: ['base.md', item.target.split(path.sep).join('/')] });
  expect(await fs.readFile(path.join(source, 'CLAUDE.md'), 'utf8')).toBe(original);
  expect(await fs.readFile(path.join(target, item.target), 'utf8')).toBe(original);
});

test('native in-place root instructions are skipped and conditional Cursor rules are archived without global activation', async () => {
  await save(source, 'AGENTS.md', 'already native');
  expect((await planSettings('codex', source, source))[0].status).toBe('unchanged');
  await save(source, '.cursor/rules/test.mdc', '---\nglobs: "src/**/*.ts"\n---\nUse strict types.');
  const [item] = await planSettings('cursor', source, target);
  expect(item.scoped).toBe(true); expect(item.activated).toBe(false);
  expect((await applySettings(item, 'keep', await settingsConfigFingerprint(target))).status).toBe('imported');
  await expect(fs.access(path.join(target, '.opencode/opencode.jsonc'))).rejects.toBeDefined();
});

test('does not copy credentials, hooks, MCP, plugins or supporting executable skill files', async () => {
  await save(source, '.claude/settings.json', '{"hooks":{"PreToolUse":"do not execute"}}');
  await save(source, '.claude/skills/test/SKILL.md', '---\nname: test\ndescription: Fixture\n---\nFixture text.');
  await save(source, '.claude/skills/test/run.sh', 'echo never run');
  await save(source, '.claude/auth.json', 'fixture-not-a-real-secret');
  const items = await planSettings('claude', source, target);
  expect(items).toHaveLength(1); expect(items[0].kind).toBe('skill');
  await applySettings(items[0], 'keep', await settingsConfigFingerprint(target));
  expect(await fs.readdir(path.dirname(path.join(target, items[0].target)))).toEqual(['SKILL.md']);
});

test('conflicts default to keep, explicit replace makes a backup and keep-both writes a separate file', async () => {
  await save(source, 'CLAUDE.md', 'new'); let [item] = await planSettings('claude', source, target);
  await save(target, item.target, 'old'); [item] = await planSettings('claude', source, target);
  expect(item.status).toBe('conflict');
  const fingerprint = await settingsConfigFingerprint(target);
  expect((await applySettings(item, 'keep', fingerprint)).status).toBe('skipped');
  expect(await fs.readFile(path.join(target, item.target), 'utf8')).toBe('old');
  expect((await applySettings(item, 'copy', fingerprint)).status).toBe('imported');
  expect(await fs.readFile(path.join(target, item.target), 'utf8')).toBe('old');
  [item] = await planSettings('claude', source, target);
  expect((await applySettings(item, 'replace', await settingsConfigFingerprint(target))).status).toBe('imported');
  expect((await fs.readdir(path.dirname(path.join(target, item.target)))).some((name) => name.endsWith('.backup'))).toBe(true);
});

test('source changes, target changes and malformed target config cannot silently overwrite files', async () => {
  await save(source, 'CLAUDE.md', 'rules'); let [item] = await planSettings('claude', source, target);
  const fingerprint = await settingsConfigFingerprint(target);
  await save(source, 'CLAUDE.md', 'changed');
  await expect(applySettings(item, 'keep', fingerprint)).rejects.toThrow('source_changed');
  [item] = await planSettings('claude', source, target);
  await save(target, 'opencode.json', '{"model":"user-edit"}');
  await expect(applySettings(item, 'keep', fingerprint)).rejects.toThrow('target_changed');
  await save(target, 'opencode.json', '{broken');
  await expect(settingsConfigFingerprint(target)).rejects.toThrow('invalid_target_config');
});

test('symlink source settings and symlink destinations fail closed', async () => {
  await save(temporary, 'outside.md', 'outside');
  await fs.symlink(path.join(temporary, 'outside.md'), path.join(source, 'CLAUDE.md'));
  await expect(planSettings('claude', source, target)).rejects.toThrow('unsafe_settings_path');
  await fs.unlink(path.join(source, 'CLAUDE.md')); await save(source, 'CLAUDE.md', 'rules');
  await fs.symlink(source, path.join(target, '.opencode'));
  await expect(planSettings('claude', source, target)).rejects.toThrow('unsafe_settings_path');
});
