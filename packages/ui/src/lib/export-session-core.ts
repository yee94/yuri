export type SessionMessageRecord = { info: { role: string; providerID?: string; modelID?: string; time?: { created?: number } }; parts: Array<{ type: string; text?: string }> };

export type ChildSessionExport = {
  title: string;
  agent?: string;
  records: SessionMessageRecord[];
  children: ChildSessionExport[];
};

function formatTimestamp(timestamp: number | undefined, locale?: string): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return '';
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const monthPart = date.toLocaleString(locale, { month: 'short' });
  const dayPart = date.getDate();
  const yearPart = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${monthPart} ${dayPart}, ${yearPart}, ${hours}:${minutes}`;
}

function formatAssistantModel(record: SessionMessageRecord): string {
  if (record.info.role === 'user') {
    return '';
  }

  const providerID = typeof record.info.providerID === 'string' ? record.info.providerID.trim() : '';
  const modelID = typeof record.info.modelID === 'string' ? record.info.modelID.trim() : '';

  if (providerID && modelID) {
    return `${providerID}/${modelID}`;
  }

  return modelID || providerID;
}

function formatMessageHeader(record: SessionMessageRecord, locale?: string): string {
  const label = record.info.role === 'user' ? 'User' : 'Assistant';
  const timestamp = formatTimestamp(record.info.time?.created, locale);
  const assistantModel = formatAssistantModel(record);
  const details = timestamp && assistantModel
    ? `${timestamp} (${assistantModel})`
    : (timestamp || assistantModel);

  return details ? `**${label}**\n\n*${details}*` : `**${label}**`;
}

function extractTextFromParts(parts: SessionMessageRecord['parts']): string {
  return parts
    .filter((p): p is { type: string; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function formatMessageAsMarkdown(record: SessionMessageRecord, locale?: string): string {
  const role = formatMessageHeader(record, locale);
  const text = extractTextFromParts(record.parts).trim();

  if (!text) return '';
  return `${role}\n\n${text}`;
}

function formatChildSessionAsMarkdown(child: ChildSessionExport, depth: number, locale?: string): string {
  const heading = '#'.repeat(Math.min(depth + 1, 6));
  const agentLabel = child.agent ? ` — ${child.agent}` : '';
  const childHeader = `${heading} Sub-agent: ${child.title}${agentLabel}\n\n---\n\n`;

  const childBody = child.records
    .map(record => formatMessageAsMarkdown(record, locale))
    .filter(Boolean)
    .join('\n\n---\n\n');

  const parts = [childHeader + childBody];

  for (const grandchild of child.children) {
    parts.push(formatChildSessionAsMarkdown(grandchild, depth + 1, locale));
  }

  return parts.join('\n\n---\n\n');
}

export function formatSessionAsMarkdown(
  messages: SessionMessageRecord[],
  sessionTitle?: string | null,
  childSessions?: ChildSessionExport[],
  locale?: string,
): string {
  const title = sessionTitle?.trim() || 'Session';
  const date = new Date().toISOString().split('T')[0];

  const header = `# ${title}\n\n*Exported on ${date}*\n\n---\n\n`;

  const body = messages
    .map(record => formatMessageAsMarkdown(record, locale))
    .filter(Boolean)
    .join('\n\n---\n\n');

  let result = header + body;

  if (childSessions && childSessions.length > 0) {
    const childMarkdown = childSessions
      .map((child) => formatChildSessionAsMarkdown(child, 1, locale))
      .join('\n\n---\n\n');
    result += '\n\n---\n\n' + childMarkdown;
  }

  return result;
}

export function buildExportFilename(sessionTitle?: string | null): string {
  const base = sessionTitle?.trim() || 'session';
  const safe = base
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const normalizedBase = safe || 'session';
  const date = new Date().toISOString().split('T')[0];
  return `${normalizedBase}-${date}.md`;
}
