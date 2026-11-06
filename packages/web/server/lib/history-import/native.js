import { digest, fail } from './events.js';

const directoryOf = (session) => session.location?.directory;
export const nativeRevision = (session, namespace) => ({ source: 'opencode', namespace, id: session.id,
  hash: digest({ id: session.id, directory: directoryOf(session) }), directory: directoryOf(session) });

// Only metadata is paged for inventory. Message projection is limited to the
// visible examples and never used by the in-place project registration job.
export async function discoverNative(client, namespace, { limitPerSource, includeCounts = false } = {}) {
  const sessions = []; const descriptors = new Map(); const errors = [];
  const seen = new Set(); const cursors = new Set(); const signal = AbortSignal.timeout(10000);
  let cursor; let complete = false;
  try {
    do {
      const page = await client.session.list({ limit: 100, ...(cursor ? { cursor } : { order: 'desc' }) }, { signal });
      if (!Array.isArray(page.data)) fail('invalid_source');
      for (const info of page.data) {
        if (seen.has(info.id)) continue;
        if (seen.size >= 5000) fail('too_many_sessions');
        seen.add(info.id);
        if (limitPerSource !== undefined && sessions.length >= limitPerSource) continue;
        const key = digest(`opencode:${namespace}:${info.id}`);
        const revision = nativeRevision(info, namespace);
        descriptors.set(key, { source: 'opencode', format: 'opencode', sessionID: info.id, namespace, revision });
        sessions.push({ key, source: 'opencode', id: info.id, title: info.title || info.id,
          directory: directoryOf(info) || '', messages: 0, warnings: [], updated: info.time?.updated });
      }
      cursor = page.cursor?.next;
      complete = !cursor;
      if (cursor && cursors.has(cursor)) fail('invalid_source');
      if (cursor) cursors.add(cursor);
    } while (cursor && (limitPerSource === undefined || includeCounts));
  } catch (error) { errors.push({ source: 'opencode', code: error.code ?? 'source_unreadable' }); }
  if (limitPerSource !== undefined) {
    await Promise.all(sessions.map(async (session) => {
      try {
        const page = await client.message.list({ sessionID: session.id, limit: 10, order: 'desc' }, { signal });
        const text = (message) => message.type === 'assistant' ? message.content?.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : message.type === 'user' ? message.text : '';
        const messages = page.data;
        if (!Array.isArray(messages)) fail('invalid_source');
        const excerpt = messages.find((message) => message.type === 'assistant' && text(message)?.trim())
          ?? messages.find((message) => message.type === 'user' && text(message)?.trim());
        session.excerpt = text(excerpt ?? {})?.slice(0, 512).replace(/\s+/g, ' ').trim().slice(0, 180) || '';
      } catch { session.warnings.push('preview_unavailable'); }
    }));
  }
  return { sessions, descriptors, errors,
    counts: includeCounts ? { opencode: { value: complete ? seen.size : null, approximate: false } } : undefined };
}
