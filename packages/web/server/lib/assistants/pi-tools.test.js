import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  collectAssistantSkillDirectories,
  createPiCodingRuntime,
  formatPiCodingPrompt,
  mergeSkillsByName,
  PI_CODING_TOOL_NAMES,
  resolveAssistantCwd,
} from './pi-tools.js';

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-pi-tools-'));
  temps.push(dir);
  return dir;
};
const writeSkill = (root, name, description = `${name} skill`) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}\n`);
};

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    fs.rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('resolveAssistantCwd', () => {
  it('starts a managed contact in the server user home while preserving its binding metadata', () => {
    const assistant = { workspacePath: null, effectiveWorkspacePath: '/managed/contact' };
    expect(resolveAssistantCwd(assistant)).toBe(os.homedir());
    expect(assistant.effectiveWorkspacePath).toBe('/managed/contact');
  });

  it('prefers effectiveWorkspacePath over workspacePath', () => {
    expect(resolveAssistantCwd({
      effectiveWorkspacePath: '/effective',
      workspacePath: '/workspace',
    })).toBe('/effective');
    expect(resolveAssistantCwd({ workspacePath: '/workspace' })).toBe('/workspace');
    expect(resolveAssistantCwd({ defaultPrompt: 'x' })).toBeNull();
  });
});

describe('collectAssistantSkillDirectories', () => {
  it('lists global ~/.claude and ~/.agents then project .claude and .agents', () => {
    const home = temp();
    const cwd = temp();
    expect(collectAssistantSkillDirectories(cwd, { homeDir: home })).toEqual([
      path.resolve(home, '.claude', 'skills'),
      path.resolve(home, '.agents', 'skills'),
      path.resolve(cwd, '.claude', 'skills'),
      path.resolve(cwd, '.agents', 'skills'),
    ]);
  });

  it('does not invent skill roots on intermediate parent folders', () => {
    const home = temp();
    const root = temp();
    const nested = path.join(root, 'apps', 'web');
    fs.mkdirSync(nested, { recursive: true });
    expect(collectAssistantSkillDirectories(nested, { homeDir: home })).toEqual([
      path.resolve(home, '.claude', 'skills'),
      path.resolve(home, '.agents', 'skills'),
      path.resolve(nested, '.claude', 'skills'),
      path.resolve(nested, '.agents', 'skills'),
    ]);
  });
});

describe('mergeSkillsByName', () => {
  it('keeps the last skill with the same name', () => {
    expect(mergeSkillsByName([
      { name: 'shared', filePath: '/global' },
      { name: 'shared', filePath: '/project' },
      { name: 'other', filePath: '/other' },
    ])).toEqual([
      { name: 'shared', filePath: '/project' },
      { name: 'other', filePath: '/other' },
    ]);
  });
});

describe('formatPiCodingPrompt', () => {
  it('names the pi coding tools without a schema catalog and distinguishes skills from tools', async () => {
    const cwd = temp();
    const home = temp();
    const runtime = await createPiCodingRuntime(cwd, { homeDir: home });
    const prompt = formatPiCodingPrompt({
      cwd: runtime.cwd,
      skillsPrompt: runtime.skillsPrompt,
    });
    expect(prompt).toContain('read, write, edit, bash');
    expect(prompt).not.toContain('arguments schema:');
    expect(prompt).not.toContain('"oldText"');
    expect(prompt).not.toContain('yuri-tool');
    expect(prompt).toContain('not OpenCode native tools and not MCP');
    expect(prompt).toContain('never invent skill or MCP tool names');
    expect(prompt).toContain('context7');
    expect(prompt).toContain('small, bounded tasks');
    expect(prompt).toContain('worker session via assign_session');
    await runtime.close();
  });
});

describe('createPiCodingRuntime', () => {
  it.each([undefined, 99999, 5])('caps the actual bash execution timeout for requested %s seconds', async (timeout) => {
    const runtime = await createPiCodingRuntime(temp(), { homeDir: temp() });
    const exec = vi.spyOn(NodeExecutionEnv.prototype, 'exec').mockResolvedValue({ ok: true, value: { stdout: '', stderr: '', exitCode: 0 } });
    try {
      const bash = runtime.tools.find((tool) => tool.name === 'bash');
      expect(bash.parameters.properties.timeout.maximum).toBe(300);
      await bash.execute('bounded', { command: 'unused mock command', ...(timeout === undefined ? {} : { timeout }) });
      expect(exec).toHaveBeenCalledWith('unused mock command', expect.objectContaining({ timeout: timeout === 5 ? 5 : 300 }));
    } finally { await runtime.close(); }
  });

  it('kills the real shell and its child on a shorter timeout', async () => {
    const cwd = temp();
    const runtime = await createPiCodingRuntime(cwd, { homeDir: temp() });
    const pidFile = path.join(cwd, 'child-pids');
    let pids = [];
    try {
      const bash = runtime.tools.find((tool) => tool.name === 'bash');
      await expect(bash.execute('kill-tree', { command: 'sleep 60 & child=$!; printf "%s\\n" "$$" "$child" > child-pids; wait', timeout: 0.3 })).rejects.toThrow('timed out');
      pids = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
      expect(pids).toHaveLength(2);
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally {
      await runtime.close();
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Fixture process already exited. */ }
      }
    }
  });

  it('installs read/write/edit/bash and merges global plus project skills', async () => {
    const home = temp();
    const cwd = temp();
    writeSkill(path.join(home, '.claude', 'skills'), 'claude-global', 'Claude global');
    writeSkill(path.join(home, '.agents', 'skills'), 'agents-global', 'Agents global');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'claude-project', 'Claude project');
    writeSkill(path.join(cwd, '.agents', 'skills'), 'project-skill', 'Project skill');
    writeSkill(path.join(home, '.agents', 'skills'), 'shared', 'Global shared');
    writeSkill(path.join(cwd, '.agents', 'skills'), 'shared', 'Project shared');

    const runtime = await createPiCodingRuntime(cwd, { homeDir: home });
    expect(runtime.tools.map((tool) => tool.name)).toEqual([...PI_CODING_TOOL_NAMES]);
    expect(runtime.skillsPrompt).toContain('claude-global');
    expect(runtime.skillsPrompt).toContain('agents-global');
    expect(runtime.skillsPrompt).toContain('claude-project');
    expect(runtime.skillsPrompt).toContain('project-skill');
    expect(runtime.skillsPrompt).toContain('Project shared');
    expect(runtime.skillsPrompt).not.toContain('Global shared');
    await runtime.close();
  });

  it('runs bash pwd in the workspace', async () => {
    const cwd = temp();
    const home = temp();
    const runtime = await createPiCodingRuntime(cwd, { homeDir: home });
    const bash = runtime.tools.find((tool) => tool.name === 'bash');
    const result = await bash.execute('call_pwd', { command: 'pwd' });
    const text = result.content.map((part) => part.text).join('');
    const resolved = fs.realpathSync(cwd);
    expect(text.includes(cwd) || text.includes(resolved)).toBe(true);
    await runtime.close();
  });
});
