import { signal } from 'nsh';
import { list, record, request, textOf } from '../core/host';
import { t } from '../core/i18n';
import { parseSchedule, type Schedule } from '../scheduled/data';

export type AssistantFallbackKind = 'image' | 'file' | 'session' | 'assistant' | 'schedule';
export type AssistantPreview = {
  createdAt?: number;
  messageID: string;
  ordinal: number;
  role: 'user' | 'assistant';
  text: string;
  fallbackKind: AssistantFallbackKind | null;
};

export type Assistant = {
  id: string;
  name: string;
  avatarSeed?: string;
  pinnedAt: number | null;
  revision: number;
  enabled: boolean;
  defaultPrompt: string;
  workspacePath: string | null;
  effectiveWorkspacePath: string;
  providerID: string;
  modelID: string;
  agent: string | null;
  variant: string | null;
  mode: 'continuous' | 'stateless';
  sessionID: string | null;
  sessionGeneration: number;
  unreadCount: number;
  readTip: { generation: number; ordinal: number; messageID: string } | null;
  working: boolean;
  latestMessagePreview: AssistantPreview | null;
};

export type Capability = { supported: boolean; enabled: boolean };
export type Snapshot = { revision: number; enabled: boolean; assistants: Assistant[] };

const readPosition = (value: unknown) => {
  const row = record(value);
  const messageID = textOf(row.messageID);
  if (!messageID) return null;
  return {
    generation: Number(row.generation) || 0,
    ordinal: Number(row.ordinal) || 0,
    messageID,
  };
};

const parsePreview = (value: unknown): AssistantPreview | null => {
  const row = record(value);
  const text = textOf(row.text);
  const fallback = textOf(row.fallbackKind);
  const fallbackKind =
    fallback === 'image' || fallback === 'file' || fallback === 'session' || fallback === 'assistant' || fallback === 'schedule'
      ? fallback
      : null;
  const messageID = textOf(row.messageID);
  if (!messageID && !text && !fallbackKind) return null;
  return {
    messageID,
    ordinal: Number(row.ordinal) || 0,
    role: textOf(row.role) === 'user' ? 'user' : 'assistant',
    text,
    fallbackKind,
    ...(typeof row.createdAt === 'number' ? { createdAt: row.createdAt } : {}),
  };
};

export function parseAssistant(value: unknown): Assistant | null {
  const row = record(value);
  const id = textOf(row.id);
  if (!id) return null;
  const pinned = row.pinnedAt;
  return {
    id,
    name: textOf(row.name) || id,
    ...(textOf(row.avatarSeed) ? { avatarSeed: textOf(row.avatarSeed) } : {}),
    pinnedAt: typeof pinned === 'number' && pinned > 0 ? pinned : null,
    revision: Number(row.revision) || 0,
    enabled: row.enabled !== false,
    defaultPrompt: textOf(row.defaultPrompt),
    workspacePath: textOf(row.workspacePath) || null,
    effectiveWorkspacePath: textOf(row.effectiveWorkspacePath),
    providerID: textOf(row.providerID),
    modelID: textOf(row.modelID),
    agent: textOf(row.agent) || null,
    variant: textOf(row.variant) || null,
    mode: textOf(row.mode) === 'stateless' ? 'stateless' : 'continuous',
    sessionID: textOf(row.sessionID) || null,
    sessionGeneration: Number(row.sessionGeneration) || 0,
    unreadCount: Number(row.unreadCount) || 0,
    readTip: readPosition(row.readTip),
    working: row.working === true,
    latestMessagePreview: parsePreview(row.latestMessagePreview),
  };
}

const state = {
  capability: signal<Capability | null>(null),
  snapshot: signal<Snapshot | null>(null),
  loading: signal(false),
  error: signal(''),
};

export const assistantCapability = () => state.capability();
export const assistantSnapshot = () => state.snapshot();
export const assistantLoading = () => state.loading();
export const assistantError = () => state.error();
export const assistants = () => state.snapshot()?.assistants ?? [];
export const assistantsEnabled = () => state.snapshot()?.enabled ?? false;
export const assistantByID = (id: string) => assistants().find((assistant) => assistant.id === id) ?? null;

/** Web `partitionAssistantContacts`: the single pinned contact first, the rest newest first. */
export const assistantContacts = () => {
  let head: Assistant | null = null;
  for (const assistant of assistants()) {
    if (assistant.pinnedAt != null && (!head || assistant.pinnedAt > (head.pinnedAt ?? 0))) head = assistant;
  }
  const pinned = head ? [head] : [];
  const unpinned = assistants()
    .filter((assistant) => assistant !== head)
    .sort((left, right) => {
      const leftAt = left.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
      const rightAt = right.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
      return leftAt === rightAt ? 0 : rightAt - leftAt;
    });
  return { pinned, unpinned };
};

export const assistantTitle = (assistant: Assistant) => assistant.name.trim() || assistant.id;

const previewFallbackKey = {
  image: 'assistants.contact.attachment.image',
  file: 'assistants.contact.attachment.file',
  session: 'assistants.contact.card.session.untitled',
  assistant: 'assistants.title',
  schedule: 'assistants.settings.scheduledTasks.title',
} as const;

/** Web `getAssistantMessagePreview`: bounded text, with the same fallback labels. */
export const assistantPreviewText = (assistant: Assistant): string => {
  const preview = assistant.latestMessagePreview;
  const source = preview?.text ?? '';
  const text = (
    preview?.fallbackKind
      ? source
      : source
          .replace(/^\s{0,3}(?:`{3,}|~{3,})[\w+-]*(?:\s+|$)/gmu, '')
          .replace(/`{3,}|~{3,}/gu, '')
          .replace(/^\s{0,3}(?:#{1,6}\s+|(?:>\s*)+|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gmu, '')
          .replace(/!?\[([^\]\n]*)\]\([^\n)]*(?:\)|$)/gu, '$1')
          .replace(/!\[([^\]\n]*)(?:\]|$)/gu, '$1')
          .replace(/(`+)([^`\n]+)\1/gu, '$2')
          .replace(/(\*{1,3}|~~)(?=\S)(.+?)\1/gu, '$2')
          .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)(.+?)\1(?![\p{L}\p{N}_])/gu, '$2')
  )
    .replace(/\s+/gu, ' ')
    .trim();
  if (text) return text;
  return t(preview?.fallbackKind ? previewFallbackKey[preview.fallbackKind] : 'assistants.contact.empty');
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function loadAssistants(force = false): Promise<void> {
  state.loading.set(true);
  state.error.set('');
  try {
    let capability = state.capability();
    if (!capability || force) {
      const row = record(await request('/api/yuri/assistants/capability'));
      capability = { supported: row.supported !== false, enabled: row.enabled !== false };
      state.capability.set(capability);
    }
    if (!capability.supported) {
      state.snapshot.set(null);
      return;
    }
    const snapshot = record(await request('/api/yuri/assistants/snapshot'));
    state.snapshot.set({
      revision: Number(snapshot.revision) || 0,
      enabled: snapshot.enabled !== false,
      assistants: list(snapshot.assistants)
        .map(parseAssistant)
        .filter((assistant): assistant is Assistant => !!assistant),
    });
  } catch (error) {
    state.error.set(errorText(error));
  } finally {
    state.loading.set(false);
  }
}

function replaceAssistant(next: Assistant) {
  const snapshot = state.snapshot();
  if (!snapshot) return;
  const known = snapshot.assistants.some((assistant) => assistant.id === next.id);
  state.snapshot.set({
    ...snapshot,
    assistants: known
      ? snapshot.assistants.map((assistant) => (assistant.id === next.id ? next : assistant))
      : [...snapshot.assistants, next],
  });
}

function patchLocal(id: string, patch: Partial<Assistant>) {
  const snapshot = state.snapshot();
  if (!snapshot) return;
  state.snapshot.set({
    ...snapshot,
    assistants: snapshot.assistants.map((assistant) =>
      assistant.id === id ? { ...assistant, ...patch } : assistant,
    ),
  });
}

export async function saveAssistant(
  assistant: Assistant | null,
  draft: {
    name: string;
    avatarSeed?: string;
    defaultPrompt: string;
    workspacePath: string | null;
    providerID: string;
    modelID: string;
    agent?: string | null;
    mode?: 'continuous' | 'stateless';
    pinned?: boolean;
    enabled?: boolean;
  },
): Promise<Assistant> {
  const payload = {
    ...draft,
    ...(assistant ? { expectedRevision: assistant.revision } : {}),
  };
  const saved = parseAssistant(
    await request(assistant ? `/api/yuri/assistants/${encodeURIComponent(assistant.id)}` : '/api/yuri/assistants', assistant ? 'PATCH' : 'POST', payload),
  );
  if (!saved) throw new Error('Invalid bot response');
  replaceAssistant(saved);
  if (draft.pinned !== undefined) await loadAssistants(true);
  return saved;
}

export async function deleteAssistant(id: string, revision: number): Promise<void> {
  await request(`/api/yuri/assistants/${encodeURIComponent(id)}`, 'DELETE', { expectedRevision: revision });
  const snapshot = state.snapshot();
  if (snapshot) {
    state.snapshot.set({ ...snapshot, assistants: snapshot.assistants.filter((assistant) => assistant.id !== id) });
  }
}

/** Web `AssistantContactMenu`: pin or unpin one contact from its long-press menu. */
export async function toggleAssistantPin(assistant: Assistant): Promise<void> {
  const saved = parseAssistant(
    await request(`/api/yuri/assistants/${encodeURIComponent(assistant.id)}`, 'PATCH', {
      pinned: assistant.pinnedAt == null,
      expectedRevision: assistant.revision,
    }),
  );
  if (saved) replaceAssistant(saved);
}

export async function markAssistantRead(assistant: Assistant): Promise<void> {
  if (!assistant.readTip) return;
  await request(`/api/yuri/assistants/${encodeURIComponent(assistant.id)}/contact/read`, 'POST', {
    ...assistant.readTip,
  });
  patchLocal(assistant.id, { unreadCount: 0 });
}

export async function markAllAssistantsRead(): Promise<number> {
  const targets = assistants().filter((assistant) => assistant.unreadCount > 0 && assistant.readTip);
  let failed = 0;
  for (let index = 0; index < targets.length; index += 4) {
    const batch = targets.slice(index, index + 4);
    const results = await Promise.allSettled(batch.map((assistant) => markAssistantRead(assistant)));
    failed += results.filter((result) => result.status === 'rejected').length;
  }
  return failed;
}

export type AssistantBinding = { sessionID: string | null; directory: string; sessionGeneration: number };

export async function ensureAssistantSession(id: string): Promise<AssistantBinding> {
  const value = record(await request(`/api/yuri/assistants/${encodeURIComponent(id)}/session/ensure`, 'POST', {}));
  const binding = {
    sessionID: textOf(value.sessionID) || null,
    directory: textOf(value.directory),
    sessionGeneration: Number(value.sessionGeneration) || 0,
  };
  patchLocal(id, {
    sessionID: binding.sessionID,
    sessionGeneration: binding.sessionGeneration,
    ...(binding.directory ? { effectiveWorkspacePath: binding.directory } : {}),
  });
  return binding;
}

// --- channels ---

export type ChannelStatus = {
  status: string;
  error: string | null;
  configured: boolean;
  clientID: string;
  ownerID: string;
  hasSecret: boolean;
};

export type ChannelProvider = 'wecom' | 'feishu' | 'dingtalk';

export async function readChannel(id: string, provider: ChannelProvider): Promise<ChannelStatus> {
  try {
    const row = record(await request(`/api/yuri/assistants/${encodeURIComponent(id)}/channels/${provider}`, 'GET'));
    return {
      status: textOf(row.status) || 'unsupported',
      error: textOf(row.error) || null,
      configured: row.configured === true,
      clientID: textOf(row.clientID),
      ownerID: textOf(row.ownerID),
      hasSecret: row.hasSecret === true,
    };
  } catch (error) {
    return { status: 'unsupported', error: errorText(error), configured: false, clientID: '', ownerID: '', hasSecret: false };
  }
}

export async function saveChannel(
  id: string,
  provider: ChannelProvider,
  input: { clientID: string; clientSecret?: string; ownerID: string },
): Promise<void> {
  await request(`/api/yuri/assistants/${encodeURIComponent(id)}/channels/${provider}`, 'PUT', input);
}

export async function disconnectChannel(id: string, provider: ChannelProvider): Promise<void> {
  await request(`/api/yuri/assistants/${encodeURIComponent(id)}/channels/${provider}`, 'DELETE');
}

export async function retryChannel(id: string, provider: ChannelProvider): Promise<void> {
  await request(`/api/yuri/assistants/${encodeURIComponent(id)}/channels/${provider}/retry`, 'POST', {});
}

export type WeixinStatus = { status: string; error: string | null; qrCode: string };

const parseWeixin = (row: Record<string, unknown>): WeixinStatus => ({
  status: textOf(row.status) || 'unsupported',
  error: textOf(row.error) || null,
  qrCode: textOf(row.qrCode),
});

export async function readWeixin(id: string): Promise<WeixinStatus> {
  try {
    return parseWeixin(record(await request(`/api/yuri/assistants/${encodeURIComponent(id)}/weixin`, 'GET')));
  } catch (error) {
    return { status: 'unsupported', error: errorText(error), qrCode: '' };
  }
}

export async function weixinAction(id: string, action: 'login' | 'disconnect' | 'retry'): Promise<WeixinStatus> {
  const row = record(
    await request(
      `/api/yuri/assistants/${encodeURIComponent(id)}/weixin${action === 'disconnect' ? '' : `/${action}`}`,
      action === 'disconnect' ? 'DELETE' : 'POST',
      {},
    ),
  );
  return parseWeixin(row);
}

export async function verifyWeixin(id: string, code: string): Promise<WeixinStatus> {
  const row = record(
    await request(`/api/yuri/assistants/${encodeURIComponent(id)}/weixin/verify`, 'POST', { code }),
  );
  return parseWeixin(row);
}

// --- assistant tasks ---

export type AssistantTask = {
  projectID: string;
  taskID: string;
  name: string;
  enabled: boolean;
  lastStatus: string;
  nextRunAt: number;
  schedule: Schedule;
};

export async function readAssistantTasks(id: string): Promise<AssistantTask[]> {
  const value = await request(`/api/yuri/assistants/${encodeURIComponent(id)}/scheduled-tasks`, 'GET');
  const rows = Array.isArray(value) ? value : list(record(value).tasks);
  return rows
    .map(record)
    .map((row) => {
      const task = record(row.task);
      const taskState = record(task.state);
      return {
        projectID: textOf(row.projectID) || textOf(row.projectId),
        taskID: textOf(task.id),
        name: textOf(task.name) || textOf(task.id),
        enabled: task.enabled !== false,
        lastStatus: textOf(taskState.lastStatus) || 'idle',
        nextRunAt: Number(taskState.nextRunAt) || 0,
        schedule: parseSchedule(task.schedule),
      };
    })
    .filter((task) => task.taskID);
}
