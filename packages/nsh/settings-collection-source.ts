import { parse } from 'yaml';
import type { Row } from './model';
import { scopedSettingsPath, settingsObject, type SettingsRequest } from './settings-protocol';

/** Same Markdown frontmatter delimiter and YAML parser as the Host, without filesystem imports. */
export function collectionMarkdownDefinition(raw: string, bodyKey: 'template' | 'instructions'): Row {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { [bodyKey]: raw };
  const frontmatter = match[1].trim() ? settingsObject(parse(match[1], { logLevel: 'silent' })) : {};
  return { ...frontmatter, [bodyKey]: match[2].trim() };
}
export function collectionAgentMarkdown(raw: string): { frontmatter: Row; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };
  return { frontmatter: match[1].trim() ? settingsObject(parse(match[1], { logLevel: 'silent' })) : {}, body: match[2].trim() };
}
export async function readCollectionDefinitionFile(send: SettingsRequest, path: string, directory?: string): Promise<string> {
  const raw = await send(scopedSettingsPath(`/api/fs/read?path=${encodeURIComponent(path)}`, directory));
  if (typeof raw !== 'string') throw new Error('Invalid definition file');
  return raw;
}
