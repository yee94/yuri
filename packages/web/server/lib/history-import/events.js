// Reader/normalization adaptations from Agent Connect (MIT), commit
// 42287c14a8fd381bc7ef7a96076a5cba5b4d75f6. See AGENT_CONNECT_LICENSE.
import { createHash } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const fail = (code) => { throw Object.assign(new Error(code), { code }); };
export const timestamp = (value, fallback = 0) => {
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};
export const textOf = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => textOf(part?.text ?? part?.content ?? '')).filter(Boolean).join('\n');
  return value == null ? '' : JSON.stringify(value);
};

// Preserve repeated genuine messages. Only source-specific duplicate encodings
// and the explicitly shared prefix of selected conversations are deduplicated.
export function combineSessions(sessions) {
  if (sessions.length < 2) fail('merge_requires_sessions');
  const events = [...sessions[0].events];
  const signatures = sessions[0].events.map(eventSignature);
  for (const session of sessions.slice(1)) {
    let common = 0;
    while (common < signatures.length && common < session.events.length && signatures[common] === eventSignature(session.events[common])) common++;
    const remainder = session.events.slice(common);
    if (!remainder.length) continue;
    events.push({ kind: 'marker', text: `[Imported conversation: ${session.title}]`, time: remainder[0].time });
    events.push(...remainder);
  }
  return events;
}
const eventSignature = ({ kind, text, name, input, output, files }) => digest({ kind, text, name, input, output, files });

function activeClaudeChain(entries, warnings) {
  const messages = new Map();
  const progress = new Map();
  for (const entry of entries) {
    if (entry.type === 'progress' && entry.uuid) {
      progress.set(entry.uuid, progress.get(entry.parentUuid) ?? entry.parentUuid);
    } else if (['user', 'assistant', 'system', 'attachment'].includes(entry.type) && entry.uuid) {
      messages.set(entry.uuid, { ...entry, parentUuid: progress.get(entry.parentUuid) ?? entry.parentUuid });
    }
  }
  if (!messages.size) return entries.filter((entry) => !entry.isSidechain);
  // Relink compact's retained segment before removing snipped messages.
  const values = [...messages.values()];
  const lastBoundary = values.findLastIndex((entry) => entry.type === 'system' && entry.subtype === 'compact_boundary');
  const boundary = values[lastBoundary];
  const segment = boundary?.compactMetadata?.preservedSegment;
  if (segment) {
    const kept = new Set();
    let current = messages.get(segment.tailUuid);
    while (current && !kept.has(current.uuid)) {
      kept.add(current.uuid);
      if (current.uuid === segment.headUuid) break;
      current = messages.get(current.parentUuid);
    }
    const anchor = messages.get(segment.anchorUuid);
    const anchorIndex = values.findIndex((entry) => entry.uuid === segment.anchorUuid);
    const anchorSeen = new Set();
    let cursor = anchor;
    let valid = true;
    while (cursor) {
      if (kept.has(cursor.uuid) || anchorSeen.has(cursor.uuid)) { valid = false; break; }
      anchorSeen.add(cursor.uuid);
      if (cursor.parentUuid && !messages.has(cursor.parentUuid)) { valid = false; break; }
      cursor = messages.get(cursor.parentUuid);
    }
    if (current?.uuid === segment.headUuid && anchor && anchorIndex >= lastBoundary && valid) {
      messages.get(segment.headUuid).parentUuid = segment.anchorUuid;
      for (const entry of messages.values()) {
        if (entry.parentUuid === segment.anchorUuid && entry.uuid !== segment.headUuid) entry.parentUuid = segment.tailUuid;
      }
      for (const entry of values.slice(0, lastBoundary)) if (!kept.has(entry.uuid)) messages.delete(entry.uuid);
    } else warnings.add('branch_incomplete');
  }
  const deleted = new Map();
  for (const entry of messages.values()) {
    for (const id of entry.snipMetadata?.removedUuids ?? []) if (messages.has(id)) deleted.set(id, messages.get(id).parentUuid);
  }
  for (const id of deleted.keys()) messages.delete(id);
  for (const entry of messages.values()) {
    const seen = new Set();
    while (deleted.has(entry.parentUuid) && !seen.has(entry.parentUuid)) {
      seen.add(entry.parentUuid); entry.parentUuid = deleted.get(entry.parentUuid);
    }
  }
  let leaf;
  for (const entry of messages.values()) {
    if (!entry.isSidechain && (!leaf || timestamp(entry.timestamp) > timestamp(leaf.timestamp))) leaf = entry;
  }
  const chain = [];
  const seen = new Set();
  while (leaf && !seen.has(leaf.uuid)) {
    seen.add(leaf.uuid); chain.push(leaf);
    if (leaf.parentUuid && !messages.has(leaf.parentUuid)) warnings.add('branch_incomplete');
    leaf = messages.get(leaf.parentUuid);
  }
  chain.reverse();
  // Parallel assistant fragments share one provider message ID, even when only
  // one fragment is on the parent chain. Recover siblings and their tool results.
  const providerIDs = new Set(chain.filter((entry) => entry.type === 'assistant').map((entry) => entry.message?.id).filter(Boolean));
  const siblings = new Map();
  for (const entry of messages.values()) {
    if (entry.type === 'assistant' && providerIDs.has(entry.message?.id) && !entry.isSidechain) {
      const group = siblings.get(entry.message.id) ?? []; group.push(entry); siblings.set(entry.message.id, group);
    }
  }
  const results = new Map();
  for (const entry of messages.values()) {
    if (entry.type === 'user' && Array.isArray(entry.message?.content) && entry.message.content.some((part) => part.type === 'tool_result')) {
      const group = results.get(entry.parentUuid) ?? []; group.push(entry); results.set(entry.parentUuid, group);
    }
  }
  const recovered = [];
  for (const entry of chain) {
    recovered.push(entry);
    if (entry.type !== 'assistant') continue;
    for (const sibling of siblings.get(entry.message?.id) ?? []) {
      if (!seen.has(sibling.uuid)) { recovered.push(sibling); seen.add(sibling.uuid); }
      for (const result of results.get(sibling.uuid) ?? []) if (!seen.has(result.uuid)) { recovered.push(result); seen.add(result.uuid); }
    }
  }
  if (messages.size > seen.size || deleted.size) warnings.add('inactive_branches_omitted');
  return recovered;
}

const contextPrefixes = ['# agents.md instructions', '<user_instructions', '<environment_context', '<additional_context', '<skill', '<system-reminder', '<permissions instructions', '<turn_aborted', '<subagent_notification', '<internal_model_context', '<user_shell_command'];
function codexUser(entry) {
  const payload = entry.payload;
  if (entry.type === 'event_msg' && payload?.type === 'user_message') return { kind: 'event', text: textOf(payload.message) };
  if (entry.type === 'event_msg' && payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') return { kind: 'event', text: textOf(payload.item.content) };
  if (entry.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
    const text = textOf(payload.content);
    if (!contextPrefixes.some((prefix) => text.trimStart().toLowerCase().startsWith(prefix))) return { kind: 'response', text };
  }
  return null;
}
function codexBoundaries(lines) {
  const boundaries = []; let pending;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]; const user = codexUser(line);
    if (user) {
      if (pending && user.kind !== pending.kind && (!user.text.trim() || !pending.text.trim() || user.text.trim() === pending.text.trim())) {
        boundaries.push({ ...pending, secondary: index, text: user.kind === 'event' ? user.text || pending.text : pending.text || user.text }); pending = undefined;
      } else { if (pending) boundaries.push(pending); pending = { ...user, index }; }
    } else if (line.type === 'response_item' && line.payload?.role !== 'user' || line.type === 'compacted' || line.type === 'event_msg' && ['agent_message', 'agent_reasoning', 'turn_started', 'turn_complete', 'turn_aborted'].includes(line.payload?.type)) {
      if (pending) boundaries.push(pending); pending = undefined;
    }
  }
  if (pending) boundaries.push(pending);
  return boundaries;
}

export function parseTranscript(source, entries, fallbackID, fallbackTime = 0) {
  const warnings = new Set(['tools_archived', 'usage_unknown']);
  const head = source === 'codex' ? entries.find((entry) => entry.type === 'session_meta')?.payload ?? {} : entries[0] ?? {};
  let id = head.sessionId ?? head.session_id ?? head.id ?? fallbackID;
  let directory = head.cwd ?? '';
  let title = '';
  const events = [];
  const add = (kind, text, entry, extra = {}) => {
    if (!text && !extra.files?.length && kind !== 'tool') return;
    events.push({ kind, text, time: timestamp(entry.timestamp ?? entry.time ?? entry.createdAt, fallbackTime), ...extra });
  };
  const blocks = (content, role, entry, results = new Map()) => {
    if (typeof content === 'string') { add(role, content, entry); return; }
    if (!Array.isArray(content)) return;
    let text = ''; let files = [];
    const flush = () => { add(role, text, entry, files.length ? { files } : {}); text = ''; files = []; };
    for (const part of content) {
      if (['text', 'input_text', 'output_text'].includes(part.type)) text += `${text ? '\n' : ''}${part.text ?? ''}`;
      else if (part.type === 'thinking' || part.type === 'reasoning') { flush(); add('thinking', part.thinking ?? part.text ?? '', entry); }
      else if (part.type === 'tool_use' || part.type === 'tool-call') {
        flush();
        const result = results.get(part.id ?? part.toolCallId);
        add('tool', '', entry, { name: part.name ?? part.toolName, input: part.input ?? part.args ?? part.arguments ?? {}, output: textOf(result?.content ?? result?.result), incomplete: !result, isError: result?.is_error === true || result?.isError === true });
        if (!result) warnings.add('unfinished_tools');
      } else if (role === 'user' && part.type === 'image' && part.source?.type === 'base64') {
        files.push({ data: part.source.data, mime: part.source.media_type, source: { type: 'inline' } });
      } else if (!['tool_result', 'tool-result'].includes(part.type)) warnings.add('attachments_omitted');
    }
    flush();
  };
  if (source === 'claude') {
    const messages = activeClaudeChain(entries, warnings);
    const results = new Map();
    for (const entry of messages) for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) if (part.type === 'tool_result') results.set(part.tool_use_id, part);
    for (const entry of entries) {
      if (entry.type === 'custom-title') title = entry.customTitle ?? title;
      else if (entry.type === 'ai-title' && !title) title = entry.aiTitle ?? '';
      directory ||= entry.cwd ?? ''; id = entry.sessionId ?? id;
    }
    for (const entry of messages) {
      if (entry.type === 'user' || entry.type === 'assistant') blocks(entry.message?.content, entry.isMeta ? 'marker' : entry.type === 'assistant' ? 'assistant-text' : 'user', entry, results);
      else if (entry.subtype === 'compact_boundary') add('marker', '[Claude Code context compaction]', entry);
    }
  } else if (source === 'codex') {
    const lines = [];
    for (const entry of entries) {
      if (entry.type === 'event_msg' && entry.payload?.type === 'thread_rolled_back') {
        const count = entry.payload.num_turns;
        if (!Number.isInteger(count) || count < 1) fail('invalid_source');
        const boundaries = codexBoundaries(lines);
        if (boundaries.length) lines.length = boundaries[Math.max(0, boundaries.length - count)].index;
        warnings.add('inactive_branches_omitted');
      } else lines.push(entry);
    }
    const boundaries = codexBoundaries(lines); const users = new Map(boundaries.map((boundary) => [boundary.index, boundary]));
    const secondary = new Set(boundaries.map((boundary) => boundary.secondary)); const outputs = new Map();
    for (const entry of lines) if (entry.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(entry.payload?.type)) outputs.set(entry.payload.call_id, entry.payload);
    const nativeCopies = new Map(); let segment = 0;
    const copyKey = (kind, text) => JSON.stringify([segment, kind, text]);
    for (let index = 0; index < lines.length; index++) {
      const entry = lines[index]; const payload = entry.payload;
      if (users.has(index) || entry.type === 'compacted') segment++;
      const kind = payload?.type === 'reasoning' ? 'thinking' : payload?.type === 'message' && payload.role === 'assistant' ? 'assistant-text' : undefined;
      if (entry.type !== 'response_item' || !kind) continue;
      const text = textOf(kind === 'thinking' ? payload.summary : payload.content);
      const key = copyKey(kind, text);
      nativeCopies.set(key, (nativeCopies.get(key) ?? 0) + 1);
    }
    segment = 0;
    for (let index = 0; index < lines.length; index++) {
      const entry = lines[index]; const payload = entry.payload;
      if (users.has(index) || entry.type === 'compacted') segment++;
      if (users.has(index)) add('user', users.get(index).text, entry);
      else if (secondary.has(index)) continue;
      else if (entry.type === 'response_item') {
        if (payload?.type === 'message' && payload.role === 'assistant') blocks(payload.content, 'assistant-text', entry);
        else if (payload?.type === 'reasoning') add('thinking', textOf(payload.summary), entry);
        else if (['function_call', 'custom_tool_call'].includes(payload?.type)) {
          const result = outputs.get(payload.call_id);
          add('tool', '', entry, { name: payload.name, input: payload.arguments ?? payload.input ?? {}, output: textOf(result?.output), incomplete: !result });
          if (!result) warnings.add('unfinished_tools');
        }
      } else if (entry.type === 'event_msg' && ['agent_message', 'agent_reasoning'].includes(payload?.type)) {
        const kind = payload.type === 'agent_message' ? 'assistant-text' : 'thinking';
        const text = textOf(payload.message ?? payload.text);
        const key = copyKey(kind, text); const copies = nativeCopies.get(key) ?? 0;
        if (copies) nativeCopies.set(key, copies - 1);
        else add(kind, text, entry);
      } else if (entry.type === 'compacted') add('marker', `[Codex context compaction]\n${payload?.message ?? entry.message ?? ''}`, entry);
    }
  } else if (source === 'dsh') {
    if (head.type !== 'session' || !head.id || head.version != null && ![0, 1, 2, 3, 4].includes(head.version)) fail('unsupported_source_version');
    const surface = []; const surfaceTypes = ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'];
    let expectedSeq = 0;
    for (const entry of entries.slice(1)) {
      if (entry.seq !== undefined && entry.seq !== expectedSeq) fail('invalid_source');
      expectedSeq++;
      if (!surfaceTypes.includes(entry.type)) continue;
      if (entry.surfaceOp && entry.surfaceOp !== 'append') {
        const op = entry.surfaceOp;
        if (op.op !== 'replace') fail('unsupported_source_version');
        const start = surface.findIndex((item) => item.seq === op.startSeq);
        const end = surface.findIndex((item) => item.seq === op.endSeq);
        if (start < 0 || end < start) fail('invalid_source');
        surface.splice(start, end - start + 1, entry); warnings.add('inactive_branches_omitted');
      } else surface.push(entry);
    }
    const results = new Map();
    const calls = new Set();
    for (const entry of surface) {
      if (entry.type === 'tool/result') {
        const message = entry.data?.message;
        const result = message?.content?.find((part) => part.type === 'tool-result');
        results.set(result?.toolCallId ?? message?.source?.callId ?? message?.callId, result ?? message);
      }
      if (entry.type === 'assistant/message') for (const part of entry.data?.message?.content ?? []) if (part.type === 'tool-call') calls.add(part.id);
    }
    for (const entry of entries) if (entry.type === 'session/title') title = entry.data?.title ?? entry.data?.value ?? title;
    for (const entry of surface) {
      const data = entry.data ?? {};
      if (entry.type === 'user/message') blocks(data.content, data.source?.kind === 'user' ? 'user' : 'marker', entry);
      else if (entry.type === 'assistant/message') {
        const message = data.message ?? {};
        blocks(message.content, 'assistant-text', entry, results);
      } else if (entry.type === 'system/message' || entry.type === 'developer/message') blocks(data.message?.content, 'marker', entry);
      else if (entry.type === 'tool/result') {
        const message = data.message; const result = message?.content?.find((part) => part.type === 'tool-result');
        const callID = result?.toolCallId ?? message?.source?.callId ?? message?.callId;
        if (!calls.has(callID)) add('marker', `[Historical tool result]\n${textOf(result?.content ?? message?.content)}`, entry);
      }
    }
    if (head.parentSession) warnings.add('fork_archived');
  } else if (source === 'cursor') {
    for (const entry of entries) {
      const role = entry.role ?? entry.message?.role;
      if (role === 'user' || role === 'assistant') blocks(entry.message?.content ?? entry.content ?? entry.text, role === 'user' ? 'user' : 'assistant-text', entry);
      directory ||= entry.cwd ?? '';
    }
  } else fail('invalid_source');
  if (!events.length) fail('empty_transcript');
  title ||= events.find((event) => event.kind === 'user')?.text?.replace(/\s+/g, ' ').slice(0, 100) ?? String(id);
  let parentID = source === 'codex' ? head.source?.subagent?.thread_spawn?.parent_thread_id ?? head.parent_thread_id
    : head.origin === 'subagent' || head.delegationDepth > 0 ? head.parentSession : undefined;
  if (parentID != null && String(parentID) === String(id)) { parentID = undefined; warnings.add('parent_detached'); }
  return { id: String(id), title: String(title).slice(0, 200), directory, parentID, events, warnings: [...warnings] };
}

export function toNativeTransfer(session, directory, sessionID, provenance, parentID) {
  const model = { providerID: 'imported', id: 'historical' };
  const messages = session.events.map((event, index) => {
    const id = `msg_${digest(`${sessionID}:${index}`).slice(0, 32)}`;
    const time = { created: event.time };
    if (event.kind === 'user') return { type: 'user', id, time, text: event.text ?? '', ...(event.files?.length ? { files: event.files } : {}) };
    const text = event.kind === 'tool' ? `[Historical tool: ${event.name ?? 'unknown'}${event.incomplete ? ' — unfinished' : ''}]\nInput: ${textOf(event.input)}\nOutput: ${event.output ?? ''}` : event.text ?? '';
    return { type: 'assistant', id, time: { ...time, completed: event.time }, agent: 'build', model,
      content: [{ type: event.kind === 'thinking' ? 'reasoning' : 'text', text }], finish: 'stop' };
  });
  const created = session.events[0]?.time ?? 0;
  const updated = session.events.reduce((latest, event) => Math.max(latest, event.time), created);
  return {
    location: { directory },
    info: { id: sessionID, projectID: 'imported', location: { directory }, title: session.title,
      ...(parentID ? { parentID } : {}), cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, updated }, metadata: { historyImport: provenance } },
    messages,
  };
}
