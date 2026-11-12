import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatAssistantBuiltinSkillsPrompt } from './builtin-skills.js';

describe('assistant built-in skill pointers', () => {
  it('advertises only the two requested skills, with existing instruction readers', () => {
    const prompt = formatAssistantBuiltinSkillsPrompt([{ name: 'read' }, { name: 'read_opencode_skill' }]);
    expect(prompt.match(/^- /gm)).toHaveLength(2);
    expect(prompt).toContain('load_tools({"domain":"opencode.catalog"})');
    expect(prompt).toContain('read_opencode_skill({"id":"opencode"})');
    expect(prompt).toContain('nextOffset');
    expect(prompt).toContain('adding a directory as a project in Yuri');
    expect(prompt).toContain('granted yuri.projects tools');
    expect(prompt).toContain('no bound local desktop helper');
    expect(prompt).toContain('does not create that authorization');
    expect(prompt).not.toContain('.opencode/skills');

    const file = JSON.parse(prompt.match(/read\(\{"path":(".*?")\}\)/)[1]);
    const expected = fileURLToPath(new URL('../gui-customization/skill/SKILL.md', import.meta.url));
    expect(file).toBe(expected);
    expect(prompt).toContain(JSON.stringify(path.dirname(expected)));
    const source = fs.readFileSync(file, 'utf8');
    expect(prompt).not.toContain('## Workflow');
    for (const [, reference] of source.matchAll(/\]\((references\/[^)]+)\)/g)) {
      expect(fs.existsSync(path.join(path.dirname(file), reference))).toBe(true);
    }
  });

  it('omits pointers whose readers were not granted', () => {
    expect(formatAssistantBuiltinSkillsPrompt([])).toBe('');
    const local = formatAssistantBuiltinSkillsPrompt([{ name: 'read' }]);
    expect(local).toContain('- yuri-customization:');
    expect(local).not.toContain('- opencode:');
    const connected = formatAssistantBuiltinSkillsPrompt([{ name: 'read_opencode_skill' }]);
    expect(connected).toContain('- opencode:');
    expect(connected).not.toContain('- yuri-customization:');
  });
});
