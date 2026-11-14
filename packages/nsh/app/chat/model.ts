import { list, record, textOf, unwrap, type Row } from '../core/host';
import { isProcessGroupTool, isToolPartActive } from '../../../ui/src/components/chat/message/parts/toolRenderUtils';
import { summarizeProcessTools } from './toolGroups';

export type Role = 'user' | 'assistant' | 'compaction';

export type ParsedPart = { key: string; kind: string; raw: Row };

export type ParsedMessage = {
  id: string;
  role: Role;
  info: Row;
  parts: ParsedPart[];
  attachments: Row[];
};

export type ParsedPage = { messages: ParsedMessage[]; cursor: string | null; complete: boolean };

/** Display order of one row: the messages it stacks, oldest first. */
export type RowGroup = {
  key: string;
  ids: string[];
  role: Role;
  last: boolean;
  live: boolean;
  active: boolean;
};

const ROLE_ALIASES: Record<string, Role> = {
  user: 'user',
  peer: 'user',
  shell: 'user',
  synthetic: 'user',
  assistant: 'assistant',
  compaction: 'compaction',
};

const partRole = (raw: Row): Role => {
  const type = textOf(raw.type) || textOf(raw.role);
  if (textOf(raw.clientRole) === 'compaction') return 'compaction';
  return ROLE_ALIASES[type] ?? 'assistant';
};

const partKind = (raw: Row): string => {
  const type = textOf(raw.type);
  return type || 'text';
};

/** One stable key per part: text and reasoning by kind + ordinal, tools by call id. */
export function partKey(messageID: string, raw: Row, index: number): string {
  const type = partKind(raw);
  if (type === 'tool') return `${messageID}|tool|${textOf(raw.id) || index}`;
  if (type === 'file') return `${messageID}|file|${textOf(raw.url) || textOf(raw.uri) || index}`;
  const ordinal = typeof raw.ordinal === 'number' ? raw.ordinal : index;
  return `${messageID}|${type}|${ordinal}`;
}

const ordinals = (raw: Row): number => (typeof raw.ordinal === 'number' ? raw.ordinal : -1);

function infoFrom(raw: Row, id: string, role: Role): Row {
  const model = record(raw.model);
  const metadata = record(raw.metadata);
  const metadataModel = record(metadata.model);
  const identity = Object.keys(model).length ? model : role === 'user' ? metadataModel : {};
  const time = record(raw.time);
  const tokens = record(raw.tokens);
  const providerID = textOf(identity.providerID) || textOf(raw.providerID);
  const modelID = textOf(identity.id) || textOf(identity.modelID) || textOf(raw.modelID);
  const variant = textOf(identity.variant) || textOf(raw.variant) || (role === 'user' ? textOf(metadata.variant) : '');
  const agent = textOf(raw.agent) || (role === 'user' ? textOf(metadata.agent) : '');
  const error = textOf(record(raw.error).message) || (raw.status === 'error' ? textOf(raw.text) : '');
  return {
    id,
    role,
    ...(providerID ? { providerID } : {}),
    ...(modelID ? { modelID } : {}),
    ...(modelID ? { modelName: textOf(identity.name) || textOf(raw.modelName) } : {}),
    ...(variant ? { variant } : {}),
    ...(agent ? { agent } : {}),
    ...(textOf(raw.finish) ? { finish: textOf(raw.finish) } : {}),
    ...(error ? { error } : {}),
    time,
    tokens,
    ...(textOf(raw.parentID) ? { parentID: textOf(raw.parentID) } : {}),
    ...(textOf(raw.nativeType) ? { nativeType: textOf(raw.nativeType) } : {}),
    ...(Number.isFinite(raw.created) ? { created: raw.created } : {}),
    ...(textOf(raw.summary) ? { summary: textOf(raw.summary) } : {}),
  };
}

/** One wire message (`{ info, parts }`, or a flat row) as the transcript shows it. */
export function messageFrom(input: unknown): ParsedMessage | null {
  let raw = record(input);
  if (raw.info && typeof raw.info === 'object') raw = { ...record(raw.info), parts: raw.parts };
  const id = textOf(raw.id) || textOf(raw.messageID);
  if (!id) return null;
  const role = partRole(raw);
  const source = Array.isArray(raw.parts) ? list(raw.parts) : list(raw.content);
  const counters: Record<string, number> = {};
  const parts: ParsedPart[] = [];
  for (let index = 0; index < source.length; index++) {
    const part = source[index]!;
    if (partRole(part) === 'compaction') continue;
    if (ordinals(part) < 0) {
      const kind = partKind(part);
      part.ordinal = counters[kind] ?? 0;
      counters[kind] = (counters[kind] ?? 0) + 1;
    }
    parts.push({ key: partKey(id, part, index), kind: partKind(part), raw: part });
  }
  const attachments = [
    ...source.filter((part) => textOf(part.type) === 'file'),
    ...list(raw.files),
  ];
  return { id, role, info: infoFrom(raw, id, role), parts, attachments };
}

export function messagesFrom(payload: unknown, limit = 20): ParsedPage {
  const value = record(payload);
  const rows = Array.isArray(value.data) ? value.data : Array.isArray(value.messages) ? value.messages : null;
  if (!rows) throw new Error('Invalid message page');
  const messages = rows
    .map(messageFrom)
    .filter((message): message is ParsedMessage => !!message);
  messages.reverse();
  const cursor = textOf(record(value.cursor).next) || textOf(value.cursor) || null;
  const complete = !cursor || rows.length < limit;
  return { messages, cursor: complete ? null : cursor, complete };
}

export function sessionInfoFrom(payload: unknown): Row {
  return record(unwrap(payload));
}

/** Text a user turn shows: its text part plus the file names it carries. */
export function userText(message: ParsedMessage): string {
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => textOf(part.raw.text))
    .join('\n\n');
}

export function isCompactionMessage(message: ParsedMessage): boolean {
  return message.role === 'compaction';
}

export function toolName(part: Row): string {
  return textOf(part.name) || textOf(part.tool);
}

export function toolState(part: Row): Row {
  return record(part.state);
}

export const toolSettled = (part: Row): boolean => !isToolPartActive(part);
export const teamTool = (name: string): boolean => isProcessGroupTool(name);

export type ActivityCounts = ReturnType<typeof summarizeProcessTools>;

export function activityCounts(names: readonly string[]): ActivityCounts {
  return summarizeProcessTools(names);
}

const COUNT_LABELS: Array<[string, string]> = [
  ['read', 'read'],
  ['search', 'search'],
  ['list', 'list'],
  ['bash', 'bash'],
  ['edit', 'edit'],
  ['write', 'write'],
  ['fetch', 'fetch'],
  ['task', 'task'],
];

/** “3 reads · 1 edit” — the counts Web's activity header shows. */
export function activitySummary(counts: ActivityCounts, label: (key: string) => string): string {
  const out: string[] = [];
  for (const [key, fallback] of COUNT_LABELS) {
    const count = (counts as Record<string, unknown>)[key];
    if (typeof count === 'number' && count > 0) out.push(`${count} ${label(fallback)}`);
  }
  return out.join(' · ');
}

/** Consecutive assistant messages of one turn; a user message starts a new row. */
export function groupRows(messages: readonly { id: string; role: Role }[], live: boolean): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const message of messages) {
    if (message.role === 'compaction') {
      groups.push({ key: message.id, ids: [message.id], role: 'compaction', last: false, live, active: false });
      continue;
    }
    const previous = groups[groups.length - 1];
    if (message.role === 'assistant' && previous && previous.role === 'assistant') {
      previous.ids.push(message.id);
      continue;
    }
    groups.push({ key: message.id, ids: [message.id], role: message.role, last: false, live, active: false });
  }
  return groups;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 100) / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total - minutes * 60);
  return `${minutes}m ${seconds}s`;
}

export function messageDuration(info: Row): number {
  const time = record(info.time);
  const created = Number(time.created) || 0;
  const completed = Number(time.completed) || Number(time.streamed) || 0;
  if (!created || !completed || completed < created) return 0;
  return completed - created;
}

export function messageTps(info: Row): string {
  const tokens = record(info.tokens);
  const output = Number(tokens.output) || 0;
  const duration = messageDuration(info);
  if (!output || !duration) return '';
  const rate = output / (duration / 1000);
  if (!Number.isFinite(rate) || rate <= 0) return '';
  return rate >= 10 ? `${Math.round(rate)} tok/s` : `${rate.toFixed(1)} tok/s`;
}

/* Question forms: the Web runtime's mapping kept local so the app bundle stays
   free of the shared module's runtime-only imports. */

export type QuestionOption = { label: string; description: string };

export type QuestionEntry = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
};

export type QuestionForm = {
  id: string;
  sessionID: string;
  questions: QuestionEntry[];
  tool?: { messageID: string; callID: string };
};

const questionTool = (item: Row): QuestionForm['tool'] | undefined => {
  const direct = record(item.tool);
  const metadata = record(record(item.metadata).tool);
  const messageID = textOf(direct.messageID) || textOf(metadata.messageID);
  if (!messageID) return undefined;
  return { messageID, callID: textOf(direct.id) || textOf(metadata.id) };
};

/** A form row (or legacy question request) as the question card reads it. */
export function questionFor(item: Row): QuestionForm {
  const listed = list(item.questions);
  const fields = list(item.fields);
  const questions: QuestionEntry[] = listed.length
    ? listed.map((question) => ({
        question: textOf(question.question),
        header: textOf(question.header),
        options: list(question.options).map((option) => ({
          label: textOf(option.label),
          description: textOf(option.description),
        })),
        ...(question.multiple ? { multiple: true } : {}),
      }))
    : fields.length
      ? fields.map((field) => {
          const header = textOf(field.title) || textOf(field.key);
          const question = textOf(field.description) || textOf(item.title) || header;
          const options: QuestionOption[] = list(field.options)
            .map((option) => ({
              label: textOf(option.label) || textOf(option.value),
              description: textOf(option.description),
            }))
            .filter((option) => option.label.length > 0);
          return { question, header, options, ...(textOf(field.type) === 'multiselect' ? { multiple: true } : {}) };
        })
      : [{ question: textOf(item.title) || 'Form', header: textOf(item.title) || 'Form', options: [] }];
  const tool = questionTool(item);
  return { id: textOf(item.id), sessionID: textOf(item.sessionID), questions, ...(tool ? { tool } : {}) };
}

/** Form answers with the field keys and value types the form schema declares. */
export function answersToFormAnswer(answers: string[][], fields: readonly Row[]): Row {
  const answer: Row = {};
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const key = textOf(field.key);
    const options = list(field.options);
    const values = (answers[index] ?? []).map((value) => {
      const matched = options.find((option) => (textOf(option.label) || textOf(option.value)) === value);
      return matched ? textOf(matched.value) : value;
    });
    const value = values[0] ?? '';
    const type = textOf(field.type);
    if (type === 'multiselect') answer[key] = values;
    else if (type === 'number' || type === 'integer') {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || (type === 'integer' && !Number.isInteger(number))) {
        throw new Error(`Invalid numeric answer for ${key}`);
      }
      answer[key] = number;
    } else if (type === 'boolean') {
      if (value !== 'true' && value !== 'false') throw new Error(`Invalid boolean answer for ${key}`);
      answer[key] = value === 'true';
    } else answer[key] = value;
  }
  return answer;
}
