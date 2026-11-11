import path from 'node:path';
import { fileURLToPath } from 'node:url';

const customizationSkillPath = fileURLToPath(new URL('../gui-customization/skill/SKILL.md', import.meta.url));

export function formatAssistantBuiltinSkillsPrompt(tools) {
  const names = new Set(tools.map((tool) => tool.name));
  const skills = [];
  if (names.has('read_opencode_skill')) {
    skills.push('- opencode: For OpenCode itself: configuration, agents, skills, tools, permissions, MCP, providers, plugins, CLI, SDK/API and troubleshooting. Load load_tools({"domain":"opencode.catalog"}), then read_opencode_skill({"id":"opencode"}); continue with nextOffset when partial. Use the current connected catalog, not a copied skill body or a virtual built-in file path.');
  }
  if (names.has('read')) {
    skills.push(`- yuri-customization: For Yuri appearance, themes/CSS/layout, logos/Dock, GUI plugins, pages/tabs, widgets, file previews/exports, panels and settings, or SSH/config-sync/Relay capability boundaries. Load with read({"path":${JSON.stringify(customizationSkillPath)}}), then read only the matching references relative to ${JSON.stringify(path.dirname(customizationSkillPath))}. This contact has no bound local desktop helper for SSH, configuration sync or Relay pairing; those operations are unavailable here. Reading the skill does not create that authorization.`);
  }
  return skills.length > 0 ? [
    'Built-in skills (progressive instructions): load the matching skill before following its workflow. Reading instructions does not mount tools or grant permissions; use the actual contact tools, or assign substantive implementation to a worker with the relevant context.',
    ...skills,
  ].join('\n') : '';
}
