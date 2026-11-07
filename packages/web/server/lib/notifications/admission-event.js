const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const key = (kind, parts) => {
  if (!parts.every(id)) return null;
  const value = ['admitted', kind, ...parts.map(part => `${part.length}_${part}`)].join('_');
  return value.length <= 384 ? value : null;
};

/** Content-free proof emitted only by the owning notification delivery decision. */
export function notificationAdmission(input) {
  if (!exact(input, ['v', 'kind', 'eventID', 'target', 'source']) || input.v !== 1) return null;
  if (!exact(input.target, ['kind', 'id']) || !id(input.target.id)) return null;
  const source = input.source;
  let expected;
  if (['completion', 'subtask', 'error', 'question', 'permission', 'goal'].includes(input.kind)) {
    if (!exact(source, ['type', 'sessionID', 'directory', 'parentID', 'boundaryID']) || source.type !== 'session'
      || !id(source.sessionID) || typeof source.directory !== 'string' || !source.directory.trim() || source.directory.length > 4096
      || !(source.parentID === null || id(source.parentID)) || !id(source.boundaryID)
      || input.target.kind !== 'session' || input.target.id !== source.sessionID
      || (input.kind === 'subtask' ? !source.parentID : source.parentID !== null)) return null;
    expected = key(input.kind, [source.sessionID, source.boundaryID]);
  } else if (input.kind === 'assistant') {
    if (!exact(source, ['type', 'assistantID', 'turnID', 'status', 'publication']) || source.type !== 'assistant'
      || !id(source.assistantID) || !id(source.turnID) || !['complete', 'error'].includes(source.status)
      || source.publication !== 'published' || input.target.kind !== 'assistant' || input.target.id !== source.assistantID) return null;
    expected = key(input.kind, [source.assistantID, source.turnID]);
  } else if (input.kind === 'schedule') {
    if (!exact(source, ['type', 'projectID', 'taskID', 'runID', 'trigger', 'resultOwner', 'status']) || source.type !== 'schedule'
      || !id(source.projectID) || !id(source.taskID) || !id(source.runID) || source.trigger !== 'scheduled'
      || source.resultOwner !== 'unowned' || !['success', 'error'].includes(source.status)
      || input.target.kind !== 'schedule' || input.target.id !== source.taskID) return null;
    expected = key(input.kind, [source.projectID, source.taskID, source.runID]);
  } else return null;
  if (!expected || input.eventID !== expected) return null;
  return { v: 1, kind: input.kind, eventID: expected, target: { ...input.target }, source: { ...source } };
}

export function createNotificationAdmission(kind, target, source) {
  const parts = source.type === 'session' ? [source.sessionID, source.boundaryID]
    : source.type === 'assistant' ? [source.assistantID, source.turnID] : [source.projectID, source.taskID, source.runID];
  return notificationAdmission({ v: 1, kind, target, source, eventID: key(kind, parts) });
}
