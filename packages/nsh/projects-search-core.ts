import { scoreByFuzzyQuery } from '../ui/src/lib/search/fuzzySearch';
import { nameOf, record, text, unwrap, type Project } from './model';

export type ProjectSearchCommand = { id: string; title: string; keywords?: string; group: 'commands' | 'settings'; onSelect: () => void };
export type SearchSession = { id: string; title: string; directory: string; updated: number };
export type SearchMessage = { sessionID: string; messageID: string; title: string; directory: string; snippet: string; role: 'user' | 'assistant'; createdAt: number };
export type SearchFile = { path: string; directory: string };
export type SearchGroup = 'sessions' | 'commands' | 'settings' | 'projects' | 'files';
export type SearchConversation = { session: SearchSession; hit?: SearchMessage };

export function searchSessionsFrom(payload: unknown): SearchSession[] {
  const value = record(payload);
  if (!Array.isArray(value.data)) throw new Error('Invalid session search response');
  const rows: SearchSession[] = [];
  for (const raw of value.data) {
    const row = record(raw);
    if (text(row.parentID)) continue;
    const id = text(row.id), directory = text(record(row.location).directory) || text(row.directory);
    if (!id || !directory) throw new Error('Invalid session search identity');
    rows.push({ id, directory, title: text(row.title), updated: Number(record(row.time).updated) || Number(record(row.time).created) || 0 });
  }
  return rows;
}

export function searchMessagesFrom(payload: unknown): SearchMessage[] {
  const value = record(payload);
  if (!Array.isArray(value.hits)) throw new Error('Invalid content search response');
  return value.hits.map(raw => {
    const row = record(raw), sessionID = text(row.sessionID), messageID = text(row.messageID), directory = text(row.directory);
    if (!sessionID || !messageID || !directory || (row.role !== 'user' && row.role !== 'assistant')
      || typeof row.snippet !== 'string' || typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) throw new Error('Invalid content search identity');
    return { sessionID, messageID, directory, title: text(row.title), snippet: row.snippet, role: row.role, createdAt: row.createdAt };
  });
}

export function searchFilesFrom(payload: unknown, directory: string): SearchFile[] {
  const value = unwrap(payload);
  if (!Array.isArray(value)) throw new Error('Invalid file search response');
  const paths = new Set<string>();
  for (const row of value) {
    const path = typeof row === 'string' ? row : text(record(row).path);
    if (!path) throw new Error('Invalid file search hit');
    paths.add(path);
  }
  return [...paths].map(path => ({ path, directory }));
}

/** Same-session title/content matches are one result; newest exact message wins, as on Web. */
export function mergeSearchConversations(sessions: SearchSession[], messages: SearchMessage[]): SearchConversation[] {
  const hits = new Map<string, SearchMessage>();
  for (const hit of messages) {
    const previous = hits.get(hit.sessionID);
    if (!previous || hit.createdAt > previous.createdAt || (hit.createdAt === previous.createdAt && hit.messageID > previous.messageID)) hits.set(hit.sessionID, hit);
  }
  const rows: SearchConversation[] = [], seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id); rows.push({ session, hit: hits.get(session.id) }); hits.delete(session.id);
  }
  for (const hit of hits.values()) rows.push({ session: { id: hit.sessionID, title: hit.title, directory: hit.directory, updated: hit.createdAt }, hit });
  return rows;
}

export function projectSearchGroups(input: {
  query: string; commands: ProjectSearchCommand[]; projects: Project[];
  sessions: SearchSession[]; messages: SearchMessage[]; files: SearchFile[];
}) {
  const query = input.query.trim(), hasQuery = !!query;
  const commands = scoreByFuzzyQuery(input.commands.filter(row => row.group === 'commands'), query, row => `${row.title} ${row.keywords ?? ''}`, { limit: 7, noFuzzy: true });
  const settings = hasQuery ? scoreByFuzzyQuery(input.commands.filter(row => row.group === 'settings'), query, row => `${row.title} ${row.keywords ?? ''}`, { limit: 7, noFuzzy: true }) : [];
  const projects = hasQuery ? scoreByFuzzyQuery(input.projects, query, row => `${row.name} ${row.path}`, { limit: 7, threshold: 0.4 }) : [];
  const files = hasQuery ? scoreByFuzzyQuery(input.files, query, row => nameOf(row.path), { limit: 10, threshold: 0.4 }) : [];
  const scores = { commands, settings, projects, files };
  const order: SearchGroup[] = hasQuery ? ['sessions', ...(['commands', 'settings', 'files', 'projects'] as const).slice().sort((a, b) => (scores[a][0]?.score ?? Infinity) - (scores[b][0]?.score ?? Infinity))] : ['sessions', 'commands'];
  return { order, commands: commands.map(row => row.item), settings: settings.map(row => row.item), projects: projects.map(row => row.item), files: files.map(row => row.item), sessions: mergeSearchConversations(input.sessions, input.messages) };
}

export function previewSearchGroup<T>(rows: T[], query: string, expanded: boolean): { visible: T[]; remaining: number } {
  const visible = query.trim() && !expanded ? rows.slice(0, 5) : rows;
  return { visible, remaining: rows.length - visible.length };
}
