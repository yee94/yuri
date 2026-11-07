import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

/** Intent only; native admission requires the originating owner's receipt. */
export type ResourceWebPreviewIntent =
  | { kind: 'html'; directory: string; path: string }
  | { kind: 'loopback'; url: string };

export type ResourceWebPreviewDecision =
  | { supported: true; intent: ResourceWebPreviewIntent }
  | { supported: false; reason: 'invalid' | 'outside-directory' | 'format-runtime-required' | 'external' };

const unsafe = /[\\\u0000-\u0020\u007f]/;
const credentialQuery = /(?:^|[?&])(?:oc_client_token|yuri_client_token|yuri_url_token|yuri_preview_token|authorization|access_token|token)=/i;
const absolutePath = (value: string) => value.startsWith('/') && !value.startsWith('//')
  && !/[\\\u0000-\u001f\u007f]/.test(value)
  && !value.slice(1).split('/').some(part => part === '.' || part === '..' || part === '');

function canonicalPath(value: string): boolean {
  return value === '/' || absolutePath(value);
}

/** No DOM/URL global is required in NSH QuickJS. Native repeats all validation. */
export function resourceWebPreviewIntent(input: { directory: string; path?: string; href?: string }): ResourceWebPreviewDecision {
  if (input.href !== undefined) {
    const href = input.href;
    if (!href || unsafe.test(href) || /%(?:00|0a|0d|5c)/i.test(href)) return { supported: false, reason: 'invalid' };
    const match = /^(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::([0-9]{1,5}))?([/?#].*)?$/i.exec(href);
    if (!match) return { supported: false, reason: 'external' };
    if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) return { supported: false, reason: 'invalid' };
    let decoded: string;
    try { decoded = decodeURIComponent((match[4] ?? '').split('#', 1)[0]); }
    catch { return { supported: false, reason: 'invalid' }; }
    if (credentialQuery.test(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) return { supported: false, reason: 'invalid' };
    return { supported: true, intent: { kind: 'loopback', url: href } };
  }
  const { directory, path } = input;
  if (!path || !canonicalPath(directory) || !canonicalPath(path)) return { supported: false, reason: 'invalid' };
  if (directory !== '/' && !path.startsWith(directory + '/')) return { supported: false, reason: 'outside-directory' };
  if (!/\.html?$/i.test(path)) return { supported: false, reason: 'format-runtime-required' };
  return { supported: true, intent: { kind: 'html', directory, path } };
}

export async function presentResourceWebPreview(
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  input: { directory: string; path?: string; href?: string },
  authority: { expectedHost: RuntimeScope | null; owner: string },
): Promise<{ closed: true }> {
  if (!authority.expectedHost) throw new Error('resource_web_scope_required');
  const decision = resourceWebPreviewIntent(input);
  if (!decision.supported) throw new Error(`Resource web preview: ${decision.reason}`);
  const result = await call('resources.web.present', { ...decision.intent, ...authority });
  if (!result || typeof result !== 'object' || !('closed' in result) || result.closed !== true) throw new Error('Invalid resource web preview response');
  return { closed: true };
}

/** Construct once with the parent's receipt; no event-time Host lookup. */
export function bindResourceWebPreview(
  expected: RuntimeScope | null,
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  identify: () => string,
) {
  const expectedHost = runtimeScopeFrom(expected), pending = new Set<string>();
  const closing = new Map<string, Promise<void>>();
  const closeOwner = (owner: string): Promise<void> => {
    const existing = closing.get(owner);
    if (existing) return existing;
    const flight = Promise.resolve().then(async () => {
      try {
        const result = await call('resources.web.close', { owner, expectedHost });
        if (result !== true) throw new Error('Invalid resource web close response');
        pending.delete(owner);
      } finally { closing.delete(owner); }
    });
    closing.set(owner, flight); return flight;
  };
  const close = async () => {
    await Promise.all([...pending].map(owner => closeOwner(owner).catch(() => {})));
  };
  return {
    close,
    async present(input: { directory: string; path?: string; href?: string }) {
      if (!expectedHost) throw new Error('resource_web_scope_required');
      const owner = identify(); pending.add(owner);
      try { return await presentResourceWebPreview(call, input, { expectedHost, owner }); }
      finally {
        // Also covers a rejected/timeout response: cleanup is exact, never global.
        if (pending.has(owner)) await closeOwner(owner).catch(() => {});
      }
    },
  };
}
