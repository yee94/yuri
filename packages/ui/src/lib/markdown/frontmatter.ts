/**
 * Strip leading YAML (`---` ... `---` or `...`) or TOML (`+++` ... `+++`)
 * frontmatter from Markdown text, tolerating UTF-8 BOM and leading blank lines.
 */
export const stripLeadingFrontmatter = (markdown: string): string => {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const leading = normalized.match(/^(?:[^\S\r\n]*\r?\n)*/)?.[0] ?? '';
  const body = normalized.slice(leading.length);
  const opening = body.match(/^(---|\+\+\+)[^\S\r\n]*\r?\n/);

  if (!opening) {
    return markdown;
  }

  const delimiter = opening[1];
  const rest = body.slice(opening[0].length);
  const closingPattern = delimiter === '---'
    ? /^(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/
    : /^\+\+\+[^\S\r\n]*(?:\r?\n|$)/;

  let offset = 0;
  let hasMetadataEntry = false;
  while (offset <= rest.length) {
    const lineEnd = rest.indexOf('\n', offset);
    const nextOffset = lineEnd === -1 ? rest.length : lineEnd + 1;
    const rawLine = rest.slice(offset, nextOffset);
    const line = rawLine.replace(/\r?\n$/, '');

    if (closingPattern.test(rawLine)) {
      return hasMetadataEntry ? rest.slice(nextOffset) : markdown;
    }

    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      if (delimiter === '---' && /^[^\s#][^:]*:\s*/.test(trimmed)) {
        hasMetadataEntry = true;
      } else if (delimiter === '+++' && /^[^\s#][^=]*=\s*/.test(trimmed)) {
        hasMetadataEntry = true;
      }
    }

    if (lineEnd === -1) break;
    offset = nextOffset;
  }

  return markdown;
};
