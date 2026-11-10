import os from 'node:os';
import path from 'node:path';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  formatSkillsForSystemPrompt,
  loadSkills,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { CONTACT_TOOL_TIMEOUT_MS } from './tool-execution.js';

const EXTERNAL_SKILL_ROOTS = Object.freeze(['.claude', '.agents']);

export const PI_CODING_TOOL_NAMES = Object.freeze(['read', 'write', 'edit', 'bash']);
const PI_CODING_TOOL_NAME_SET = new Set(PI_CODING_TOOL_NAMES);

export function isPiCodingToolName(name) {
  return typeof name === 'string' && PI_CODING_TOOL_NAME_SET.has(name);
}

export function resolveAssistantCwd(assistant) {
  if (assistant?.workspacePath === null) return os.homedir();
  for (const value of [assistant?.effectiveWorkspacePath, assistant?.workspacePath]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Global ~/.claude/skills + ~/.agents/skills, then this project cwd (.claude then .agents). Later dirs win on name. */
export function collectAssistantSkillDirectories(cwd, { homeDir = os.homedir() } = {}) {
  const dirs = [];
  const seen = new Set();
  const push = (dir) => {
    if (typeof dir !== 'string' || !dir.trim()) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push(resolved);
  };
  const home = typeof homeDir === 'string' && homeDir.trim() ? path.resolve(homeDir.trim()) : os.homedir();
  for (const root of EXTERNAL_SKILL_ROOTS) {
    push(path.join(home, root, 'skills'));
  }
  if (typeof cwd === 'string' && cwd.trim()) {
    const project = path.resolve(cwd.trim());
    for (const root of EXTERNAL_SKILL_ROOTS) {
      push(path.join(project, root, 'skills'));
    }
  }
  return dirs;
}

export function mergeSkillsByName(skills) {
  const map = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name) continue;
    map.set(name, skill);
  }
  return [...map.values()];
}

const bindHarnessTool = (tool, context) => ({
  name: tool.name,
  label: tool.label,
  description: tool.description,
  parameters: tool.name === 'bash' ? {
    ...tool.parameters,
    properties: {
      ...tool.parameters.properties,
      timeout: { ...tool.parameters.properties.timeout, exclusiveMinimum: 0, maximum: CONTACT_TOOL_TIMEOUT_MS / 1000, default: CONTACT_TOOL_TIMEOUT_MS / 1000, description: 'Timeout in seconds. Defaults to 300; maximum 300 seconds.' },
    },
  } : tool.parameters,
  execute: (toolCallId, params, signal, onUpdate) => (
    tool.execute(toolCallId, tool.name === 'bash' ? {
      ...params,
      timeout: params?.timeout === undefined ? CONTACT_TOOL_TIMEOUT_MS / 1000
        : Math.min(params.timeout, CONTACT_TOOL_TIMEOUT_MS / 1000),
    } : params, signal, onUpdate, context)
  ),
});

export function formatPiCodingPrompt({ cwd, skillsPrompt = '' } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '';
  return [
    `Working directory: ${cwd}`,
    'You have application-owned pi coding tools in this directory: read, write, edit, bash.',
    'Use this directory as the starting point for workspace discovery and small, bounded tasks. Substantial implementation belongs in a worker session via assign_session; keep this contact focused on conversation, coordination, and reporting results.',
    'For Yuri operations, use the mounted operation tools and load_tools first. Do not reverse-engineer internal HTTP routes or read application databases/configuration to bypass an unavailable operation. If the supported tools cannot perform the requested change, report that precise limitation instead of searching for a hidden API.',
    'Keep file discovery bounded: choose one relevant project and a narrow subdirectory before searching. Never recursively grep the home directory, all of ~/Code, application data/config directories, or dependency trees. Exclude node_modules, .git, build output and caches in the search command itself; piping through grep -v or head does not bound the scan. Set an explicit short bash timeout (normally 10–20 seconds) for every lookup. If it times out or fails, narrow the scope or ask for the missing target; do not repeat or expand a stalled scan.',
    'These are not OpenCode native tools and not MCP. Skill directory entries below are instructions only — load a matching skill by calling read on its path; never invent skill or MCP tool names (no context7, gh_grep, webfetch, etc.).',
    'This is your working directory. Ignore any other cwd from the environment, including temporary generator workspaces under /var/folders or os.tmpdir.',
    'When the user asks pwd, the current directory, or to look at files, call bash/read yourself. Never say you have no terminal or cannot read or write files.',
    'Skills are merged from ~/.claude/skills, ~/.agents/skills, and this project\'s .claude/skills plus .agents/skills (project wins on name). Read a skill file when the task matches its description.',
    typeof skillsPrompt === 'string' && skillsPrompt.trim() ? skillsPrompt.trim() : '',
  ].filter(Boolean).join('\n');
}

export async function createPiCodingRuntime(cwd, { homeDir = os.homedir() } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const resolved = cwd.trim();
  const env = new NodeExecutionEnv({ cwd: resolved });
  const context = { env };
  const tools = [
    bindHarnessTool(createReadTool(), context),
    bindHarnessTool(createWriteTool(), context),
    bindHarnessTool(createEditTool(), context),
    bindHarnessTool(createBashTool(), context),
  ];
  let skillsPrompt = '';
  try {
    const loaded = await loadSkills(env, collectAssistantSkillDirectories(resolved, { homeDir }));
    skillsPrompt = formatSkillsForSystemPrompt(mergeSkillsByName(loaded?.skills));
  } catch {
    skillsPrompt = '';
  }
  return {
    cwd: resolved,
    tools,
    skillsPrompt,
    close: async () => {
      await env.cleanup();
    },
  };
}
