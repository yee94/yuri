import { applyEdits, createScanner, getNodeValue, parseTree, SyntaxKind } from 'jsonc-parser';
import { isPathSpec, parseNpmSpec } from '../opencode/plugin-spec.js';

const isNpmPlugin = (entry) => {
  const value = Array.isArray(entry) ? entry[0] : (typeof entry === 'object' && entry !== null ? entry.package : entry);
  if (typeof value !== 'string') return false;
  const spec = value.trim();
  if (isPathSpec(spec)) return false;
  const parsed = parseNpmSpec(spec);
  if (parsed.malformed || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(parsed.name)) return false;
  return parsed.version === null || /^[\w.*+~^<>=| -]+$/.test(parsed.version);
};

/** Keep portable registry declarations without rewriting unrelated JSONC content. */
export const filterSyncedPluginConfig = (content) => {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = content.slice(bom.length);
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  const invalid = () => new Error('Cannot sync plugins: invalid OpenCode JSONC configuration');
  if (errors.length || (tree && tree.type !== 'object')) throw invalid();
  const seen = new Set();
  const edits = [];
  for (const property of tree?.children || []) {
    const [keyNode, valueNode] = property.children;
    const key = keyNode.value;
    if (key !== 'plugins' && key !== 'plugin') continue;
    if (seen.has(key) || valueNode.type !== 'array') throw invalid();
    seen.add(key);
    const entries = valueNode.children || [];
    const keep = entries.map((entry) => isNpmPlugin(getNodeValue(entry)));
    if (keep.every(Boolean)) continue;
    const lastKept = keep.lastIndexOf(true);
    const scanner = createScanner(text, true);
    for (const [index, entry] of entries.entries()) {
      if (!keep[index]) edits.push({ offset: entry.offset, length: entry.length, content: '' });
      scanner.setPosition(entry.offset + entry.length);
      if (scanner.scan() === SyntaxKind.CommaToken && (!keep[index] || index >= lastKept)) {
        edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: '' });
      }
    }
  }
  return bom + applyEdits(text, edits);
};
