/** Usage credentials are Host-global and are never model-access API keys. No browser/SDK imports. */
export type QuotaCredentialProvider = 'opencode-go' | 'ollama-cloud' | 'cursor';
export type QuotaCredentialField = 'workspaceId' | 'authCookie' | 'cookie' | 'accessToken' | 'refreshToken';
export type QuotaCredentialAction = 'save' | 'validate' | 'import' | 'delete';
export type QuotaCredentialStatus = { configured: boolean; workspaceId?: string };
export type QuotaCredentialRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export const quotaCredentialFields: Record<QuotaCredentialProvider, readonly QuotaCredentialField[]> = {
  'opencode-go': ['workspaceId', 'authCookie'], 'ollama-cloud': ['cookie'], cursor: ['accessToken', 'refreshToken'],
};
function isQuotaCredentialProvider(value: unknown): value is QuotaCredentialProvider {
  return value === 'opencode-go' || value === 'ollama-cloud' || value === 'cursor';
}
/** Exact provider-detail visibility mapping used by the Web ProvidersPage. */
export function quotaCredentialProviderFor(providerId: string): QuotaCredentialProvider | null {
  return providerId === 'opencode' || providerId === 'opencode-go' ? 'opencode-go'
    : providerId === 'ollama' || providerId === 'ollama-cloud' ? 'ollama-cloud' : providerId === 'cursor' ? 'cursor' : null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('quota_invalid_response');
  return value as Record<string, unknown>;
}
/** Match Web's closed status projection. Never copy masked/raw authentication metadata. */
export function projectQuotaCredentialStatus(value: unknown): QuotaCredentialStatus {
  const row = object(value);
  if (typeof row.configured !== 'boolean') throw new Error('quota_invalid_status');
  return { configured: row.configured, ...(typeof row.workspaceId === 'string' ? { workspaceId: row.workspaceId } : {}) };
}
/** Native errors intentionally discard server text: it may contain a submitted credential. */
export function quotaCredentialResponse(value: unknown): unknown {
  const row = object(value), status = row.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) throw new Error('quota_invalid_response');
  if (status < 200 || status >= 300) {
    const error = new Error('quota_request_failed') as Error & { status: number };
    error.status = status; throw error;
  }
  return row.body;
}
export function quotaCredentialBody(provider: QuotaCredentialProvider, values: Partial<Record<QuotaCredentialField, string>>): Record<string, string> {
  if (!isQuotaCredentialProvider(provider)) throw new Error('quota_invalid_provider');
  const body: Record<string, string> = {};
  for (const name of quotaCredentialFields[provider]) {
    const value = values[name] ?? '';
    if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) throw new Error('quota_invalid_field');
    body[name] = value.trim();
    if (name !== 'refreshToken' && !body[name]) throw new Error('quota_required_field');
  }
  return body;
}
export type QuotaCredentialsState = {
  status: QuotaCredentialStatus | null; loading: boolean; busy: QuotaCredentialAction | null;
  open: boolean; values: Partial<Record<QuotaCredentialField, string>>; confirmDelete: boolean;
  error: 'load' | 'operation' | null; notice: QuotaCredentialAction | null;
  recovery: 'read-required' | 'review' | null;
};
export type QuotaCredentialsDependencies = {
  providerId: QuotaCredentialProvider; send: QuotaCredentialRequest; current: () => boolean;
  changed?: (state: QuotaCredentialsState) => void;
};
type QuotaOperation = Pick<QuotaCredentialsDependencies, 'send' | 'current'>;

/** One form/Host/directory-lifetime owner. Only the necessary form draft holds secrets. */
export function createQuotaCredentials(deps: QuotaCredentialsDependencies) {
  if (!isQuotaCredentialProvider(deps.providerId)) throw new Error('quota_invalid_provider');
  const route = `/api/quota/credentials/${deps.providerId}`;
  let state: QuotaCredentialsState = { status: null, loading: false, busy: null, open: false, values: {}, confirmDelete: false, error: null, notice: null, recovery: null };
  let active = false, alive = true, version = 0, pending: object | null = null;
  let operation: QuotaOperation | null = deps;
  const publish = (patch: Partial<QuotaCredentialsState>) => { state = { ...state, ...patch }; deps.changed?.(state); };
  const current = () => alive && active && deps.current() && operation?.current() === true;
  function clear(retire: boolean) {
    version++;
    publish({ values: {}, open: false, confirmDelete: false, busy: null, loading: false, error: null, notice: retire ? null : state.notice,
      ...(retire ? { status: null, recovery: null } : { recovery: state.busy && state.busy !== 'validate' ? 'read-required' : state.recovery }) });
  }
  async function read() {
    if (!current() || pending) return;
    const captured = operation!, flight = {}; pending = flight;
    const ticket = version, valid = () => current() && captured === operation && ticket === version;
    publish({ loading: true, error: null });
    try {
      const status = projectQuotaCredentialStatus(await captured.send(route, 'GET'));
      if (valid()) publish({ status, loading: false, recovery: state.recovery ? 'review' : null });
    } catch { if (valid()) publish({ loading: false, error: 'load' }); }
    finally { if (pending === flight) { pending = null; if (ticket !== version && current()) void read(); } }
  }
  return {
    state: () => state, read,
    captureOperation() {
      const captured = operation, ticket = version;
      return () => current() && operation === captured && version === ticket;
    },
    /** Retain status/recovery on same-Host renewal. Old continuations retain their sender. */
    replaceOperation(next: QuotaOperation | null) {
      if (!alive || operation === next) return;
      version++; pending = null; operation = next;
      publish({ loading: false, busy: null,
        recovery: state.busy && state.busy !== 'validate' ? 'read-required' : state.recovery });
    },
    setActive(next: boolean) { if (!alive || next === active) return; active = next; if (!next) clear(false); },
    dispose() { if (!alive) return; active = false; alive = false; clear(true); },
    open() {
      if (!current() || pending || !state.status || state.error === 'load') return;
      publish({ open: true, values: deps.providerId === 'opencode-go' && state.status.workspaceId ? { workspaceId: state.status.workspaceId } : {}, confirmDelete: false, error: null, notice: state.notice === 'validate' ? 'validate' : null });
    },
    close() { active = false; clear(false); },
    change(name: QuotaCredentialField, value: string) {
      if (!current() || pending || !state.open || state.error === 'load' || !quotaCredentialFields[deps.providerId].includes(name)) return;
      publish({ values: { ...state.values, [name]: value }, error: null });
    },
    confirmDelete(next: boolean) {
      if (current() && !pending && state.open && state.status?.configured) publish({ confirmDelete: next });
    },
    async act(action: QuotaCredentialAction) {
      if (!current() || pending || !state.open || !state.status || state.error === 'load' || state.recovery === 'read-required') return;
      if (action === 'import' && deps.providerId !== 'cursor') return;
      if ((action === 'delete' || action === 'validate') && !state.status.configured) return;
      if (action === 'delete' && !state.confirmDelete) return;
      let body: Record<string, string> | undefined;
      try { if (action === 'save') body = quotaCredentialBody(deps.providerId, state.values); }
      catch { publish({ error: 'operation', notice: null }); return; }
      const captured = operation!, flight = {}; pending = flight;
      const ticket = version, valid = () => current() && captured === operation && ticket === version;
      publish({ busy: action, error: null, notice: null });
      try {
        const suffix = action === 'validate' || action === 'import' ? `/${action}` : '';
        const method = action === 'save' ? 'PUT' : action === 'delete' ? 'DELETE' : 'POST';
        const response = body === undefined ? captured.send(route + suffix, method) : captured.send(route + suffix, method, body);
        body = undefined;
        const reply = await response;
        if (!valid()) return;
        if (action === 'validate') {
          if (object(reply).valid !== true) throw new Error('quota_invalid_validation');
          publish({ notice: action });
        } else {
          const status = projectQuotaCredentialStatus(reply);
          if (status.configured !== (action !== 'delete')) throw new Error('quota_invalid_ack');
          publish({ status, values: {}, open: false, confirmDelete: false, notice: action, recovery: null });
        }
      } catch (failure) {
        if (!valid()) return;
        // A 4xx rejection is definitive. Lost/5xx/malformed ACKs require a read, not replay.
        const code = failure && typeof failure === 'object' && 'status' in failure ? failure.status : null;
        const rejected = typeof code === 'number' && code >= 400 && code < 500 && ![408, 425, 429].includes(code);
        publish({ error: 'operation', recovery: action === 'validate' || rejected ? state.recovery : 'read-required' });
      } finally {
        body = undefined;
        if (pending === flight) {
          pending = null;
          if (valid()) publish({ busy: null });
          else if (current()) void read();
        }
      }
    },
  };
}
