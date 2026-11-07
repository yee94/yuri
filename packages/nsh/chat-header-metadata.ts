import { scanContextTokenBaseline } from '../ui/src/sync/context-token-baseline';
import { record, text, unwrap, type ChatTarget, type Row } from './model';
import { createHeaderQuotas, type HeaderQuotaSnapshot } from './chat-header-quota';

export type ChatHeaderMetadata = {
  loading: boolean;
  errors: string[];
  title?: string;
  branch?: string;
  repository?: boolean;
  dirty?: boolean;
  model?: string;
  tokens?: number;
  limit?: number;
  pending?: boolean;
  contextStale?: boolean;
  quota?: HeaderQuotaSnapshot;
};

/** A bounded newest-first projection page, never session.tokens (which is cumulative). */
export function headerContextBaseline(payload: unknown) {
  const body = record(payload);
  if (!Array.isArray(body.data)) throw new Error('Invalid session projection');
  const rows = body.data.map(record).reverse();
  const parts = new Map<string, Row[]>();
  const messages = rows.map(row => {
    const content = Array.isArray(row.content) ? row.content.map(record) : [];
    parts.set(text(row.id), content);
    return {
      id: text(row.id), role: text(row.role) || text(row.type), type: text(row.type),
      clientRole: text(row.clientRole), status: text(row.status),
      ...(row.tokens && typeof row.tokens === 'object' ? { tokens: record(row.tokens) } : {}),
    };
  });
  return { baseline: scanContextTokenBaseline(messages, id => parts.get(id)), rows };
}

/** One parse per Host/page catalog fetch, at most 8192 numeric entries; renders only do exact lookups. */
export function headerCatalogLimits(payload: unknown): Map<string, number> {
  const root = record(payload);
  if (root.schemaVersion !== 1 || root.ok === false || !Array.isArray(root.providers)) throw new Error('Invalid model catalog');
  const limits = new Map<string, number>();
  for (const raw of root.providers.slice(0, 200)) {
    const provider = record(raw), providerID = text(provider.id);
    if (!providerID) continue;
    for (const [key, rawModel] of Object.entries(record(provider.models)).slice(0, 500)) {
      const model = record(rawModel), modelID = text(model.id) || key, value = record(model.limit).context;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) limits.set(JSON.stringify([providerID, modelID]), value);
      if (limits.size >= 8192) return limits;
    }
  }
  return limits;
}

function latestUserModel(rows: Row[], session: Row): Row {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row.type !== 'user') continue;
    const model = record(row.model ?? record(row.metadata).model);
    const providerID = text(model.providerID) || text(row.providerID);
    const id = text(model.id) || text(model.modelID) || text(row.modelID);
    if (id && providerID) return { id, providerID };
  }
  return record(session.model);
}

export function createChatHeaderMetadata(options: {
  target: ChatTarget;
  current: () => boolean;
  read: (path: string) => Promise<unknown>;
  changed: (value: ChatHeaderMetadata) => void;
  now?: () => number;
}) {
  const target = { ...options.target };
  let alive = true, revision = 0;
  let snapshot: ChatHeaderMetadata = { loading: false, errors: [] };
  let flight: Promise<void> | undefined;
  let catalog: { limits: Map<string, number>; expires: number } | undefined;
  const current = (serial: number) => alive && serial === revision && options.current();
  function publish(value: ChatHeaderMetadata) { snapshot = value; options.changed(value); }
  const quotas = createHeaderQuotas({ directory: target.directory, read: options.read, current: () => alive && options.current(), now: options.now, changed: quota => publish({ ...snapshot, quota }) });
  async function readCatalog(serial: number): Promise<Map<string, number>> {
    const now = options.now?.() ?? Date.now();
    if (catalog && catalog.expires > now) return catalog.limits;
    const limits = headerCatalogLimits(await options.read(`/api/config/catalog/providers?directory=${encodeURIComponent(target.directory)}`));
    if (current(serial)) catalog = { limits, expires: now + 60_000 };
    return limits;
  }
  async function refresh(force = false) {
    if (flight || !alive || !options.current() || target.kind !== 'session') return flight;
    if (force) catalog = undefined;
    const serial = ++revision;
    const directory = encodeURIComponent(target.directory);
    const path = `/api/session/${encodeURIComponent(target.id)}`;
    publish({ ...snapshot, loading: true, errors: [] });
    const work = (async () => {
      const results = await Promise.allSettled([
        options.read(`${path}?directory=${directory}`),
        options.read(`${path}/message?directory=${directory}&limit=20&order=desc`),
        readCatalog(serial),
        options.read(`/api/git/status?directory=${directory}&mode=light`),
      ]);
      if (!current(serial)) return;
      const next: ChatHeaderMetadata = { ...snapshot, loading: false, errors: [] };
      const value = (index: number) => {
        const result = results[index];
        if (result.status === 'rejected') { next.errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason)); return undefined; }
        return result.value;
      };
      const sessionValue = value(0), pageValue = value(1), modelValue = value(2), gitValue = value(3);
      const session = sessionValue === undefined ? undefined : record(unwrap(sessionValue));
      next.contextStale = sessionValue === undefined || pageValue === undefined || modelValue === undefined;
      if (session && session.id !== target.id) { next.contextStale = true; next.errors.push('Invalid session metadata'); publish(next); return; }
      if (session) next.title = text(session.title) || target.title;
      if (gitValue !== undefined) {
        const git = record(gitValue);
        next.branch = text(git.current) || undefined;
        next.repository = git.isGitRepository !== false;
        next.dirty = Array.isArray(git.files) && git.files.length > 0;
      }
      if (pageValue !== undefined && session) {
        try {
          const { baseline, rows } = headerContextBaseline(pageValue);
          const modelRef = latestUserModel(rows, session);
          next.model = text(modelRef.id) || text(modelRef.modelID) || undefined;
          next.limit = modelValue instanceof Map ? modelValue.get(JSON.stringify([modelRef.providerID, modelRef.id ?? modelRef.modelID])) : undefined;
          next.pending = baseline !== null && 'compacted' in baseline;
          next.tokens = baseline && !('compacted' in baseline) ? baseline.totalTokens : undefined;
        } catch (cause) { next.contextStale = true; next.errors.push(cause instanceof Error ? cause.message : String(cause)); }
      }
      publish(next);
    })();
    flight = work;
    try { await work; } finally { if (flight === work) flight = undefined; }
  }
  return {
    refresh,
    refreshQuotas: quotas.refresh,
    cancel() { revision++; flight = undefined; quotas.cancel(); },
    dispose() { alive = false; revision++; flight = undefined; quotas.dispose(); catalog = undefined; snapshot = { loading: false, errors: [] }; },
  };
}
