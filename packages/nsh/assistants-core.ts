import { list, messagesFrom, record, text, type Row } from './model';

export type AssistantWire = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export type AssistantFence = { current: () => boolean; request: AssistantWire };
const base = '/api/yuri/assistants';
export const assistantURL = (id: string, suffix = '') => `${base}/${encodeURIComponent(id)}${suffix}`;

export function assertAssistantScope(fence: AssistantFence) {
  if (!fence.current()) throw new Error('runtime_stale');
}
export async function assistantRequest(fence: AssistantFence, path: string, method = 'GET', body?: unknown): Promise<Row> {
  assertAssistantScope(fence);
  const value = record(await fence.request(path, method, body));
  assertAssistantScope(fence);
  if (value.ok === false || value.failed === true || value.partial === true) throw new Error(text(value.message) || text(value.error) || 'invalid_response');
  return value;
}

/** Admission is checked in the operation, not merely by disabling a control. Host permissions remain authoritative. */
export async function admitAssistantMutation(fence: AssistantFence) {
  const capability = await assistantRequest(fence, `${base}/capability`);
  assertAssistantScope(fence);
  if (capability.supported !== true || capability.enabled !== true) throw new Error('assistant_disabled');
  return capability;
}
export async function readAssistantSnapshot(fence: AssistantFence) {
  const snapshot = await assistantRequest(fence, `${base}/snapshot`);
  assertAssistantScope(fence);
  if (!Array.isArray(snapshot.assistants) || !Number.isSafeInteger(snapshot.revision) || typeof snapshot.enabled !== 'boolean'
    || snapshot.assistants.some(value => !text(record(value).id) || !Number.isSafeInteger(record(value).revision))
    || new Set(snapshot.assistants.map(value => text(record(value).id))).size !== snapshot.assistants.length) throw new Error('invalid_response');
  return snapshot;
}
export async function mutateAssistant(fence: AssistantFence, bot: Row, patch: Row | null) {
  if (!text(bot.id) || !Number.isSafeInteger(bot.revision)) throw new Error('revision_conflict');
  await admitAssistantMutation(fence);
  assertAssistantScope(fence);
  const response = await assistantRequest(fence, assistantURL(text(bot.id)), patch ? 'PATCH' : 'DELETE', { ...patch, expectedRevision: bot.revision });
  assertAssistantScope(fence);
  if (patch ? response.id !== bot.id || !Number.isSafeInteger(response.revision) : response.assistantID !== bot.id || typeof response.tombstoneAt !== 'number') throw new Error('invalid_response');
  return response;
}
/** Explicit transcript wipe, not a new OpenCode session and not a memory reset. */
export async function clearAssistantHistory(fence: AssistantFence, bot: Row) {
  if (!text(bot.id)) throw new Error('invalid_response');
  await admitAssistantMutation(fence);
  const response = await assistantRequest(fence, assistantURL(text(bot.id), '/contact/reset'), 'POST');
  if (response.assistantID !== bot.id || response.reset !== true || response.historyCleared !== true || !Number.isSafeInteger(response.generation) || Number(response.generation) < 0) throw new Error('invalid_response');
  return response;
}
export function assistantPreview(bot: Row, label: (key: 'assistants.contact.empty' | 'assistants.contact.attachment.image' | 'assistants.contact.attachment.file' | 'assistants.contact.card.session.untitled' | 'assistants.title' | 'assistants.settings.scheduledTasks.title') => string) {
  const preview = record(bot.latestMessagePreview);
  const value = text(preview.text).replace(/\s+/gu, ' ').trim();
  if (value) return value;
  const keys = { image: 'assistants.contact.attachment.image', file: 'assistants.contact.attachment.file', session: 'assistants.contact.card.session.untitled', assistant: 'assistants.title', schedule: 'assistants.settings.scheduledTasks.title' } as const;
  return label(keys[preview.fallbackKind as keyof typeof keys] ?? 'assistants.contact.empty');
}
export function assistantContacts(bots: Row[], search = '') {
  const needle = search.trim().toLocaleLowerCase();
  const visible = bots.filter(bot => !needle || `${text(bot.name)} ${text(record(bot.latestMessagePreview).text)}`.toLocaleLowerCase().includes(needle));
  let pinned: Row | undefined;
  for (const bot of visible) if (typeof bot.pinnedAt === 'number' && (!pinned || bot.pinnedAt > Number(pinned.pinnedAt))) pinned = bot;
  const time = (bot: Row) => typeof record(bot.latestMessagePreview).createdAt === 'number' ? Number(record(bot.latestMessagePreview).createdAt) : -Infinity;
  return { pinned, others: visible.filter(bot => bot !== pinned).sort((a, b) => time(b) - time(a)) };
}
export async function markAssistantCatalogRead(fence: AssistantFence, bots: Row[]) {
  await admitAssistantMutation(fence);
  assertAssistantScope(fence);
  const targets = bots.filter(bot => Number(bot.unreadCount) > 0 && typeof record(bot.readTip).generation === 'number');
  let failed = 0;
  for (let index = 0; index < targets.length; index += 4) {
    assertAssistantScope(fence);
    const results = await Promise.allSettled(targets.slice(index, index + 4).map(bot => assistantRequest(fence, assistantURL(text(bot.id), '/contact/read'), 'POST', { ...record(bot.readTip) })));
    assertAssistantScope(fence);
    failed += results.filter(result => result.status === 'rejected').length;
  }
  return failed;
}
export function snapshotBots(snapshot: Row) { return list(snapshot.assistants); }
/** Unresolved mapped tasks are not authoritative empty success. Keep prior valid rows visible. */
export function assistantScheduledTasks(page: Row, previous: Row[] = []) {
  if (!Array.isArray(page.tasks)) throw new Error('invalid_response');
  const rows: Row[] = list(page.tasks).map(entry => ({ ...entry, projectId: text(entry.projectID) || text(entry.projectId) }));
  const valid = rows.filter(entry => {
    const task = record(entry.task), execution = record(task.execution);
    return !!entry.projectId && !!text(task.id) && typeof task.name === 'string' && typeof task.enabled === 'boolean'
      && ['daily', 'weekly', 'once', 'cron'].includes(text(record(task.schedule).kind))
      && ['prompt', 'providerID', 'modelID'].every(key => typeof execution[key] === 'string');
  });
  const incomplete = valid.length !== rows.length;
  const identity = (entry: Row) => JSON.stringify([entry.projectId, record(entry.task).id]);
  const known = new Set(valid.map(identity));
  const tasks = [...valid, ...(incomplete ? previous.filter(entry => !known.has(identity(entry))) : [])].sort((left, right) => {
    const a = record(left.task), b = record(right.task);
    return a.enabled !== b.enabled ? a.enabled ? -1 : 1 : text(a.name).localeCompare(text(b.name));
  });
  return { tasks, incomplete };
}

/** Same old-Host recovery as Web: contact schedule cards identify actual global tasks. */
export function assistantScheduledFallback(contact: Row, global: Row, previous: Row[] = []) {
  if (!Array.isArray(global.tasks) || global.tasks.some(entry => !text(record(entry).projectId) || !text(record(record(entry).task).id))
    || global.failedProjectIds !== undefined && (!Array.isArray(global.failedProjectIds) || global.failedProjectIds.some(id => typeof id !== 'string'))) throw new Error('invalid_response');
  const references = messagesFrom(contact, true).messages.flatMap(message => message.cards).filter(card => card.cardType === 'schedule' && text(card.projectID) && text(card.taskID));
  const identities = new Set(references.map(card => JSON.stringify([card.projectID, card.taskID])));
  const failedIDs = Array.isArray(global.failedProjectIds) ? global.failedProjectIds.filter((id): id is string => typeof id === 'string') : [];
  const failedReferences = references.filter(card => failedIDs.includes(text(card.projectID)));
  const tasks = list(global.tasks).filter(entry => identities.has(JSON.stringify([entry.projectId, record(entry.task).id])) && !failedIDs.includes(text(entry.projectId)));
  return assistantScheduledTasks({ tasks: [...tasks, ...failedReferences.map(card => ({ projectID: card.projectID, taskID: card.taskID, task: null }))] }, previous);
}
