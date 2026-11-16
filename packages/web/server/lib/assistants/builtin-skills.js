import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shippedCustomizationSkillPath = fileURLToPath(new URL('../gui-customization/skill/SKILL.md', import.meta.url));

const CUSTOMIZATION_SCOPE = 'adding a directory as a project in Yuri, task/session archive or restore (归档/恢复; the task-view 「归档」 is settle-session), remote sessions, project/session resource ownership or yuri:// deep links, appearance, themes/CSS/layout, logos/Dock, GUI plugins, pages/tabs, widgets, file previews/exports, panels and settings, or SSH/config-sync/Relay pairing';

const customizationPointer = (tools, customizationSkill) => {
  const names = new Set(tools.map((tool) => tool.name));
  const bound = names.has('bash') && customizationSkill && typeof customizationSkill.file === 'string';
  const skillPath = bound ? customizationSkill.file : shippedCustomizationSkillPath;
  const load = `Load with read({"path":${JSON.stringify(skillPath)}}), then read only the matching references relative to ${JSON.stringify(path.dirname(skillPath))}.`;
  const projects = bound && customizationSkill.projectsCommand
    ? `Project, task/session archive and remote-session operations run through this bound API helper (bash); run its describe command first, then use the commands it returns: ${customizationSkill.projectsCommand}`
    : 'Project registration uses granted yuri.projects tools, not a session-bound helper.';
  const remote = bound && customizationSkill.remoteCommand
    ? `SSH setup, configuration sync and Relay pairing run only through this bound helper (bash) after reading references/remote-connections.md: ${customizationSkill.remoteCommand}`
    : 'This contact has no bound local desktop helper for SSH, configuration sync or Relay pairing; those operations are unavailable here.';
  return `- yuri-customization: For ${CUSTOMIZATION_SCOPE}. ${load} ${projects} ${remote} Reading the skill does not create that authorization.`;
};

export function formatAssistantBuiltinSkillsPrompt(tools, { customizationSkill = null } = {}) {
  const names = new Set(tools.map((tool) => tool.name));
  const skills = [];
  if (names.has('read_opencode_skill')) {
    skills.push('- opencode: For OpenCode itself: configuration, agents, skills, tools, permissions, MCP, providers, plugins, CLI, SDK/API and troubleshooting. Load load_tools({"domain":"opencode.catalog"}), then read_opencode_skill({"id":"opencode"}); continue with nextOffset when partial. Use the current connected catalog, not a copied skill body or a virtual built-in file path.');
  }
  if (names.has('read')) {
    skills.push(customizationPointer(tools, customizationSkill));
  }
  return skills.length > 0 ? [
    'Built-in skills (progressive instructions): load the matching skill before following its workflow. Reading instructions does not mount tools or grant permissions; use the actual contact tools, or assign substantive implementation to a worker with the relevant context.',
    'For an already authorized remote project, use list_projects and preserve its complete target on session/catalog operations and resource cards. Read the target machine skill through read_opencode_skill with target and directory; do not read a remote path through this Hub\'s local pi read/bash. Existing remote authorization permits task access, not SSH setup, credential changes, configuration sync or new pairing.',
    ...skills,
  ].join('\n') : '';
}
