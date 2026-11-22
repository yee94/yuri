import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanTitleText, deriveFallbackTitle, digest, textOf, timestamp, toNativeTransfer } from '../history-import/events.js';

export const importSessionOperations = ['import-session'];

const MAX_ITEMS = 50_000;
const ALLOWED_KEYS = new Set(['directory', 'title', 'source', 'sourceId', 'parentID', 'registerProject', 'messages', 'events']);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);
const EVENT_KINDS = new Set(['user', 'assistant-text', 'thinking', 'tool', 'marker']);

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const notFound = (error) => error?.status === 404 || error?.response?.status === 404
  || error?._tag === 'SessionNotFoundError' || error?._tag === 'Session.NotFoundError';
const hasControlChars = (value) => /[\x00-\x1f]/.test(value);

const failWith = (code, message) => Object.assign(new Error(message || code), { code });

export function validImportSessionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) return false;
  if (typeof input.directory !== 'string' || !input.directory.trim() || input.directory.length > 4096
    || hasControlChars(input.directory) || !path.isAbsolute(input.directory.trim())) return false;
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 500 || /\x00/.test(input.title))) return false;
  if (input.source !== undefined && (typeof input.source !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(input.source.trim()))) return false;
  if (input.sourceId !== undefined && (typeof input.sourceId !== 'string' || !input.sourceId.trim() || input.sourceId.length > 256 || hasControlChars(input.sourceId))) return false;
  if (input.parentID !== undefined && (typeof input.parentID !== 'string' || !input.parentID.trim() || input.parentID.length > 256 || hasControlChars(input.parentID))) return false;
  if (input.registerProject !== undefined && typeof input.registerProject !== 'boolean') return false;

  const hasMessages = input.messages !== undefined;
  const hasEvents = input.events !== undefined;
  if (hasMessages === hasEvents) return false;
  const items = hasMessages ? input.messages : input.events;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return false;

  if (hasMessages) {
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      if (!MESSAGE_ROLES.has(item.role)) return false;
      if (item.text !== undefined && typeof item.text !== 'string') return false;
      if (item.thinking !== undefined && typeof item.thinking !== 'string') return false;
      if (item.time !== undefined && typeof item.time !== 'number' && typeof item.time !== 'string') return false;
      if (item.tools !== undefined) {
        if (!Array.isArray(item.tools) || item.tools.length > 200) return false;
        for (const tool of item.tools) {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
          if (typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 256) return false;
          if (tool.output !== undefined && typeof tool.output !== 'string') return false;
          if (tool.incomplete !== undefined && typeof tool.incomplete !== 'boolean') return false;
          if (tool.isError !== undefined && typeof tool.isError !== 'boolean') return false;
        }
      }
    }
    return true;
  }

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (!EVENT_KINDS.has(item.kind)) return false;
    if (item.text !== undefined && typeof item.text !== 'string') return false;
    if (item.time !== undefined && typeof item.time !== 'number' && typeof item.time !== 'string') return false;
    if (item.kind === 'tool') {
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256) return false;
      if (item.output !== undefined && typeof item.output !== 'string') return false;
      if (item.incomplete !== undefined && typeof item.incomplete !== 'boolean') return false;
      if (item.isError !== undefined && typeof item.isError !== 'boolean') return false;
    }
  }
  return true;
}

function normalizeEvents(input) {
  const events = [];
  const baseTime = Date.now();
  if (Array.isArray(input.messages)) {
    for (let index = 0; index < input.messages.length; index++) {
      const msg = input.messages[index];
      const time = msg.time !== undefined ? timestamp(msg.time, baseTime + index) : baseTime + index;
      if (msg.role === 'user') {
        if (typeof msg.text === 'string' && msg.text.length > 0) events.push({ kind: 'user', text: msg.text, time });
      } else if (msg.role === 'system') {
        if (typeof msg.text === 'string' && msg.text.length > 0) events.push({ kind: 'marker', text: msg.text, time });
      } else {
        if (typeof msg.thinking === 'string' && msg.thinking.length > 0) events.push({ kind: 'thinking', text: msg.thinking, time });
        if (Array.isArray(msg.tools)) {
          for (const tool of msg.tools) {
            events.push({
              kind: 'tool',
              name: tool.name.trim(),
              input: tool.input ?? {},
              output: textOf(tool.output ?? ''),
              incomplete: tool.incomplete === true,
              ...(tool.isError === true ? { isError: true } : {}),
              time,
            });
          }
        }
        if (typeof msg.text === 'string' && msg.text.length > 0) events.push({ kind: 'assistant-text', text: msg.text, time });
      }
    }
  } else {
    for (let index = 0; index < input.events.length; index++) {
      const event = input.events[index];
      const time = event.time !== undefined ? timestamp(event.time, baseTime + index) : baseTime + index;
      if (event.kind === 'tool') {
        events.push({
          kind: 'tool',
          name: event.name.trim(),
          input: event.input ?? {},
          output: textOf(event.output ?? ''),
          incomplete: event.incomplete === true,
          ...(event.isError === true ? { isError: true } : {}),
          time,
        });
      } else if (typeof event.text === 'string' && event.text.length > 0) {
        events.push({ kind: event.kind, text: event.text, time });
      }
    }
  }
  if (!events.length) throw failWith('validation_error', 'At least one non-empty message or event is required');
  return events;
}

const projectSummary = ({ id, path: projectPath, label }) => ({ id, path: projectPath, ...(label ? { label } : {}) });
const sessionSummary = (record, fallback) => ({
  id: record.id,
  title: record.title ?? fallback.title,
  directory: record.location?.directory ?? fallback.directory,
  created: record.time?.created ?? fallback.created,
  updated: record.time?.updated ?? fallback.updated,
});

export async function runImportSession(input, { createClient, registerProject, onImported, signal }) {
  const rawDirectory = input.directory.trim();
  let canonicalDir;
  try {
    const stat = await fs.stat(rawDirectory);
    if (!stat.isDirectory()) throw failWith('validation_error', 'Destination directory must be an existing directory');
    canonicalDir = await fs.realpath(rawDirectory);
  } catch (error) {
    if (error?.code === 'validation_error') throw error;
    throw failWith('validation_error', 'Destination directory does not exist on this Host');
  }

  const events = normalizeEvents(input);
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'external';
  const sourceId = typeof input.sourceId === 'string' && input.sourceId.trim() ? input.sourceId.trim() : '';
  const parentID = typeof input.parentID === 'string' && input.parentID.trim() ? input.parentID.trim() : undefined;
  const cleanedExplicit = typeof input.title === 'string' ? cleanTitleText(input.title) : '';
  const title = (cleanedExplicit || deriveFallbackTitle(events, sourceId || 'Imported conversation')).slice(0, 200);

  const hash = digest({ version: 1, title, events });
  const provenance = {
    version: 1,
    mode: 'agent',
    usage: 'unknown',
    sources: [{ source, namespace: 'agent', id: sourceId || hash.slice(0, 32), hash }],
  };
  const sessionID = sourceId
    ? `ses_${digest({ version: 1, mode: 'agent', parentID, source, sourceId, hash, directory: canonicalDir }).slice(0, 32)}`
    : `ses_${randomUUID().replace(/-/g, '').slice(0, 32)}`;

  const transfer = toNativeTransfer({ id: sourceId || sessionID, title, directory: canonicalDir, parentID, events }, canonicalDir, sessionID, provenance, parentID);
  const client = createClient();
  if (typeof client?.session?.import !== 'function') {
    throw failWith('unsupported', 'Session import is unavailable on this Host');
  }

  let registeredProject;
  if (input.registerProject !== false && typeof registerProject === 'function') {
    const result = await registerProject({ path: canonicalDir });
    if (result?.project) registeredProject = projectSummary(result.project);
  }

  const verify = (existing) => {
    if (!existing || existing.id !== transfer.info.id || !same(existing.metadata?.historyImport, provenance)
      || existing.location?.directory !== transfer.location.directory) {
      throw failWith('session_conflict', 'Target session conflicts with an unrelated session');
    }
    return existing;
  };
  const fallbackInfo = { title: transfer.info.title, directory: canonicalDir, created: transfer.info.time.created, updated: transfer.info.time.updated };

  if (sourceId && typeof client.session.get === 'function') {
    try {
      const existing = verify(await client.session.get({ sessionID }, { signal }));
      await onImported?.(existing);
      return {
        session: sessionSummary(existing, fallbackInfo),
        ...(registeredProject ? { project: registeredProject } : {}),
        imported: false,
        skipped: true,
      };
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  try {
    const imported = await client.session.import(transfer, { signal });
    let confirmed = imported;
    if (typeof client.session.get === 'function') {
      try {
        confirmed = verify(await client.session.get({ sessionID }, { signal }));
      } catch (verifyError) {
        if (verifyError?.code === 'session_conflict') throw verifyError;
        if (!confirmed?.id) throw verifyError;
      }
    }
    const finalRecord = confirmed?.id ? confirmed : transfer.info;
    await onImported?.(finalRecord);
    return {
      session: sessionSummary(finalRecord, fallbackInfo),
      ...(registeredProject ? { project: registeredProject } : {}),
      imported: true,
      skipped: false,
    };
  } catch (error) {
    if (typeof client.session.get === 'function') {
      try {
        const existing = verify(await client.session.get({ sessionID }, { signal }));
        await onImported?.(existing);
        return {
          session: sessionSummary(existing, fallbackInfo),
          ...(registeredProject ? { project: registeredProject } : {}),
          imported: false,
          skipped: true,
        };
      } catch (verifyError) {
        if (verifyError?.code === 'session_conflict') throw verifyError;
      }
    }
    throw error?.code ? error : failWith('import_failed', 'Session import was not confirmed');
  }
}
