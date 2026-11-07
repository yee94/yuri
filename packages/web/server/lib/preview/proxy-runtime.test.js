import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';

import {
  applyPreviewPassthroughRequestHeaders,
  applyPreviewPassthroughResponseHeaders,
  classifyPreviewNavigation,
  classifyPreviewResourceError,
  createPreviewProxyRuntime,
  normalizeProxyTargetUrl,
  rewritePreviewBody,
  rewritePreviewCspHeader,
  rewritePreviewRedirectLocation,
} from './proxy-runtime.js';

const rewrite = (bodyText, kind) => rewritePreviewBody({
  bodyText,
  kind,
  proxyBasePath: '/api/preview/proxy/abc123',
  targetOrigin: 'http://127.0.0.1:3000',
});

// Invoke registered production handlers without sockets, a real Host or upstream requests.
async function nativePreviewFixture(run) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'native-preview-auth-'));
  const clients = createRemoteClientAuthRuntime({ fsPromises, path, crypto, storePath: path.join(root, 'clients.json') });
  const owner = await clients.createClient({ label: 'Synthetic owner', clientKind: 'mobile', authMethod: 'pairing', pairingId: 'fixture', usesRelay: true });
  const other = await clients.createClient({ label: 'Synthetic other', clientKind: 'mobile' });
  const auth = createUiAuth({ password: null, clientAuthController: clients });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const routes = new Map();
  const server = new EventEmitter();
  let proxyOptions;
  const runtime = createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware: options => { proxyOptions = options; return () => {}; }, responseInterceptor: callback => callback });
  const timer = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref() {} });
  try {
    runtime.attach({ post: (route, ...handlers) => routes.set(route, handlers.at(-1)), use: (route, handler) => routes.set(route, handler) },
      { server, express: { json: () => () => {} }, uiAuthController: auth, ...security });
  } finally { timer.mockRestore(); }
  const invoke = async (route, { headers = {}, body = {}, method = 'POST', url = route } = {}) => {
    const req = { headers: { host: 'fixture.invalid', ...headers }, body, method, url, originalUrl: url, socket: {} };
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, setHeader(name, value) { this.headers[name.toLowerCase()] = value; } };
    await routes.get(route)(req, res, () => { res.forwarded = true; });
    return { req, res };
  };
  const headers = { 'x-yuri-native-preview': '1', authorization: `Bearer ${owner.token}` };
  const body = { url: 'http://localhost:3000/report', ttlMs: 300000, allowExternal: false };
  const create = (overrides = {}) => invoke('/api/preview/targets', { headers, body, ...overrides });
  const read = (target, overrides = {}) => invoke('/api/preview/proxy', { method: 'GET', url: target.proxyBasePath + '/report', headers: { ...headers, 'x-yuri-preview-token': target.previewToken }, ...overrides });
  try { await run({ auth, clients, owner, other, headers, body, create, read, invoke, server, proxyOptions }); }
  finally { auth.dispose(); await fsPromises.rm(root, { recursive: true, force: true }); }
}

describe('native preview bearer-only protocol', () => {
  it('requires a real active device even on a password-less Host; header claims, cookies and URL auth cannot authorize', async () => nativePreviewFixture(async ({ create, headers, auth, invoke }) => {
    for (const extra of [{ authorization: '' }, { authorization: 'Bearer forged' }, { cookie: 'yuri_ui_session=forged' }, { origin: 'https://attacker.invalid' }, { origin: 'yuri-ui://app' }, { 'sec-fetch-site': 'same-origin' }, { referer: 'https://fixture.invalid' }, { 'x-yuri-native-preview': '2' }]) {
      expect((await create({ headers: { ...headers, ...extra } })).res.statusCode).toBe(403);
    }
    const tokenRes = { setHeader() {}, json(value) { this.body = value; } };
    await auth.handleUrlAuthToken({ headers }, tokenRes);
    expect((await create({ headers: { ...headers, authorization: `Bearer ${tokenRes.body.token}` } })).res.statusCode).toBe(403);
    expect((await invoke('/api/preview/targets', { headers: { 'x-yuri-native-preview': '1' }, body: { url: 'http://localhost/' }, url: `/api/preview/targets?yuri_url_token=${tokenRes.body.token}` })).res.statusCode).toBe(403);
  }));

  it('creates only fixed short-lived loopback scope without cookies, then binds every GET to that active client', async () => nativePreviewFixture(async ({ create, read, headers, other, clients, owner, proxyOptions, server }) => {
    const created = (await create()).res;
    expect(created.statusCode).toBe(200);
    expect(created.headers['set-cookie']).toBeUndefined();
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.expiresAt).toBeGreaterThan(Date.now());
    expect(created.body.expiresAt).toBeLessThanOrEqual(Date.now() + 300000);
    expect((await read(created.body)).res.forwarded).toBe(true);
    const upgrade = { headers: { ...headers, upgrade: 'websocket', 'x-yuri-preview-token': created.body.previewToken }, originalUrl: created.body.proxyBasePath + '/hmr' };
    expect(proxyOptions.pathFilter(upgrade.originalUrl, upgrade)).toBe(false);
    const socket = { destroyed: false, write: vi.fn(), destroy() { this.destroyed = true; } };
    server.emit('upgrade', upgrade, socket, Buffer.alloc(0));
    expect(socket.destroyed).toBe(true);
    expect(socket.write.mock.calls[0][0]).toContain('403');
    delete upgrade.headers['x-yuri-preview-token'];
    expect(proxyOptions.pathFilter(upgrade.originalUrl, upgrade)).toBe(false);
    for (const extra of [{ authorization: `Bearer ${other.token}` }, { authorization: '' }, { origin: 'https://attacker.invalid' }, { cookie: 'yuri_ui_session=forged' }, { 'sec-fetch-mode': 'cors' }, { 'x-yuri-preview-token': 'wrong' }]) {
      expect((await read(created.body, { headers: { ...headers, 'x-yuri-preview-token': created.body.previewToken, ...extra } })).res.statusCode).toBe(403);
    }
    expect((await read(created.body, { method: 'POST' })).res.statusCode).toBe(403);
    expect((await read(created.body, { headers, url: created.body.proxyBasePath + '/report?yuri_preview_token=' + created.body.previewToken })).res.statusCode).toBe(403);
    await clients.revokeClient(owner.client.id);
    expect((await read(created.body)).res.statusCode).toBe(403);
  }));

  it('preserves SSRF restrictions, rejects credential-bearing or malformed entries, and rejects expired targets', async () => nativePreviewFixture(async ({ create, read, body }) => {
    for (const patch of [{ allowExternal: true }, { ttlMs: 600000 }, { url: 'https://external.invalid/' }, { url: 'http://169.254.169.254/' }, { url: 'http://127.1/' }, { url: 'http://user@localhost/' }, { url: 'http://localhost/?%79uri_url_token=secret' }, { url: 'http://localhost/?yuri_preview_token=secret' }, { url: 'http://localhost:0/' }, { url: 'not a URL' }, { url: ' http://localhost/' }]) {
      expect((await create({ body: { ...body, ...patch } })).res.statusCode).toBe(400);
    }
    const target = (await create()).res.body;
    const now = vi.spyOn(Date, 'now').mockReturnValue(target.expiresAt + 1);
    try { expect((await read(target)).res.statusCode).toBe(404); } finally { now.mockRestore(); }
  }));

  it('admits Host-fetch Relay metadata only after the existing pairing gate, never from a stamped direct-only bearer', async () => nativePreviewFixture(async ({ create, read, headers, other, clients, owner }) => {
    const relayHeaders = { ...headers, 'x-yuri-relay-connection': 'synthetic-dispatcher', 'sec-fetch-mode': 'cors' };
    const created = (await create({ headers: relayHeaders })).res;
    expect(created.statusCode).toBe(200);
    expect((await read(created.body, { headers: { ...relayHeaders, 'x-yuri-preview-token': created.body.previewToken } })).res.forwarded).toBe(true);
    expect((await create({ headers: { ...relayHeaders, authorization: `Bearer ${other.token}` } })).res.statusCode).toBe(403);
    expect((await create({ headers: { ...relayHeaders, 'sec-fetch-site': 'cross-site' } })).res.statusCode).toBe(403);
    expect((await create({ headers: { ...relayHeaders, origin: 'https://attacker.invalid' } })).res.statusCode).toBe(403);
    expect((await create({ headers: { ...headers, 'sec-fetch-mode': 'cors' } })).res.statusCode).toBe(403);
    await clients.revokeClient(owner.client.id);
    expect((await read(created.body, { headers: { ...relayHeaders, 'x-yuri-preview-token': created.body.previewToken } })).res.statusCode).toBe(403);
  }));

  it('does not weaken the existing Web Origin gate, bypass Relay pairing, or forward native credentials upstream', async () => nativePreviewFixture(async ({ auth, clients, other, owner, create, headers, body, proxyOptions }) => {
    // Exercise the existing enabled branch with real auth and request-security Origin checks.
    auth.enabled = true;
    expect((await create({ headers: { authorization: headers.authorization } })).res.statusCode).toBe(403);
    expect((await create({ headers: { authorization: headers.authorization, origin: 'https://attacker.invalid' } })).res.statusCode).toBe(403);
    expect((await create({ headers: { authorization: headers.authorization, origin: 'http://fixture.invalid' } })).res.statusCode).toBe(200);
    expect((await create()).res.statusCode).toBe(200);
    const relayReq = token => ({ method: 'POST', url: '/api/preview/targets', headers: { authorization: `Bearer ${token}` }, body });
    expect(await auth.authorizeRelayRequest(relayReq(other.token))).toBe(false);
    expect(await auth.authorizeRelayRequest(relayReq(owner.token))).toBe(true);
    await clients.revokeClient(owner.client.id);
    expect(await auth.authorizeRelayRequest(relayReq(owner.token))).toBe(false);
    const forwarded = new Map(Object.entries({ authorization: 'secret', cookie: 'secret', 'x-yuri-ui-session': 'secret', 'x-yuri-native-preview': '1', 'x-yuri-preview-token': 'secret' }));
    proxyOptions.on.proxyReq({ removeHeader: name => forwarded.delete(name), setHeader: (name, value) => forwarded.set(name, value) }, { headers: {} });
    expect([...forwarded.keys()]).toEqual(['accept-encoding']);
  }));
});

describe('preview Inertia header passthrough', () => {
  it('forwards Inertia request headers to the preview target', () => {
    const forwarded = new Map();
    const proxyReq = {
      setHeader: (name, value) => forwarded.set(name, value),
    };

    applyPreviewPassthroughRequestHeaders({
      headers: {
        'x-inertia': 'true',
        'x-inertia-version': 'asset-hash',
        'x-unrelated': 'ignored',
      },
    }, proxyReq);

    expect(forwarded.get('x-inertia')).toBe('true');
    expect(forwarded.get('x-inertia-version')).toBe('asset-hash');
    expect(forwarded.has('x-unrelated')).toBe(false);
  });

  it('forwards Inertia response headers back to the preview client', () => {
    const forwarded = new Map();
    const res = {
      headersSent: false,
      setHeader: (name, value) => forwarded.set(name, value),
    };

    applyPreviewPassthroughResponseHeaders({
      headers: {
        'x-inertia': 'true',
        'x-inertia-location': 'http://127.0.0.1:8000/login',
        'x-unrelated': 'ignored',
      },
    }, res);

    expect(forwarded.get('x-inertia')).toBe('true');
    expect(forwarded.get('x-inertia-location')).toBe('http://127.0.0.1:8000/login');
    expect(forwarded.has('x-unrelated')).toBe(false);
  });
});

describe('preview resource error classification', () => {
  it('suppresses Astro/Vite stylesheet modules reported as failed scripts', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/styles/global.css',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/pages/support.astro?astro&type=style&index=0&lang.css',
    })).toBe('suppress');
  });

  it('suppresses framework virtual modules reported by dev servers', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/layouts/BaseLayout.astro?astro&type=script&index=0&lang.ts',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/@vite/client',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'link',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/@id/astro:scripts/page.js',
    })).toBe('suppress');
  });

  it('suppresses conservative ecosystem dev-runtime resources', () => {
    const noisyResources = [
      '/_next/static/chunks/webpack.js',
      '/_next/static/chunks/react-refresh.js',
      '/.svelte-kit/generated/client/app.js',
      '/@id/__x00__virtual:sveltekit:browser',
      '/@remix-run/dev/dist/browser.js',
      '/__hmr?runtime=remix',
      '/_nuxt/@vite/client',
      '/_nuxt/@id/virtual:nuxt:%2FUsers%2Fapp',
      '/webpack-dev-server/client/index.js',
      '/webpack/hot/dev-server.js',
      '/__webpack_hmr',
    ];

    for (const resource of noisyResources) {
      expect(classifyPreviewResourceError({
        tagName: 'script',
        url: `http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc${resource}`,
      })).toBe('suppress');
    }
  });

  it('keeps ordinary application resource failures visible', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/assets/app.js',
    })).toBe('report');

    expect(classifyPreviewResourceError({
      tagName: 'img',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/missing.png',
    })).toBe('report');

    expect(classifyPreviewResourceError({
      tagName: 'link',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/styles/missing.css',
    })).toBe('report');
  });
});

describe('preview body URL rewriting', () => {
  it('rewrites only HTML resource attributes in HTML responses', () => {
    const input = '<img src="/logo.png"><a href="/docs">Docs</a><script>const url = "/api/data";</script>';
    const output = rewrite(input, 'html');

    expect(output).toContain('src="/api/preview/proxy/abc123/logo.png"');
    expect(output).toContain('href="/api/preview/proxy/abc123/docs"');
    expect(output).toContain('const url = "/api/data";');
  });

  it('rewrites inline module imports in HTML responses', () => {
    const input = [
      '<script type="module">',
      'import RefreshRuntime from "/@react-refresh";',
      'window.__vite_plugin_react_preamble_installed__ = true;',
      '</script>',
      '<script type=module>',
      'import { injectIntoGlobalHook } from "/@react-refresh";',
      'import value from "/module.js";',
      'const url = "/api/data";',
      '</script>',
      '<script type=\'module\'>',
      'import "/entry.js";',
      '</script>',
      '<script type="text/javascript">',
      'import "/not-rewritten.js";',
      '</script>',
      '<script>const refreshUrl = "/@react-refresh";</script>',
    ].join('');
    const output = rewrite(input, 'html');

    expect(output).toContain('from "/api/preview/proxy/abc123/@react-refresh"');
    expect(output).toContain('import { injectIntoGlobalHook } from "/api/preview/proxy/abc123/@react-refresh";');
    expect(output).toContain('import value from "/api/preview/proxy/abc123/module.js";');
    expect(output).toContain('const url = "/api/data";');
    expect(output).toContain('import "/api/preview/proxy/abc123/entry.js";');
    expect(output).toContain('import "/not-rewritten.js";');
    expect(output).toContain('window.__vite_plugin_react_preamble_installed__ = true;');
    expect(output).toContain('const refreshUrl = "/@react-refresh";');
  });

  it('removes CSP meta tags that block the preview bridge', () => {
    const input = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><div>Preview</div>';
    const output = rewrite(input, 'html');

    expect(output).not.toContain('Content-Security-Policy');
    expect(output).toContain('<div>Preview</div>');
  });

  it('adds preview and URL auth tokens to rewritten proxy resources when provided', () => {
    const output = rewritePreviewBody({
      bodyText: '<script src="/entry.js"></script><script type="module">import RefreshRuntime from "/@react-refresh";</script><a href="http://localhost:3000/docs?x=1&yuri_client_token=legacy">Docs</a>',
      kind: 'html',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    });

    expect(output).toContain('src="/api/preview/proxy/abc123/entry.js?yuri_preview_token=preview-secret&yuri_url_token=url-secret"');
    expect(output).toContain('from "/api/preview/proxy/abc123/@react-refresh?yuri_preview_token=preview-secret&yuri_url_token=url-secret"');
    expect(output).toContain('href="/api/preview/proxy/abc123/docs?x=1&yuri_preview_token=preview-secret&yuri_url_token=url-secret"');
    expect(output).not.toContain('yuri_client_token');
  });

  it('rewrites only CSS imports and url references in CSS responses', () => {
    const input = '@import "/theme.css"; .hero { background: url(/hero.png); } .copy::after { content: "/not-a-url"; }';
    const output = rewrite(input, 'css');

    expect(output).toContain('@import "/api/preview/proxy/abc123/theme.css"');
    expect(output).toContain('url(/api/preview/proxy/abc123/hero.png)');
    expect(output).toContain('content: "/not-a-url"');
  });

  it('rewrites only JavaScript static import specifiers in JavaScript responses', () => {
    const input = 'import "/entry.js"; import value from "/module.js"; const url = "/api/data"; fetch("/api/data");';
    const output = rewrite(input, 'javascript');

    expect(output).toContain('import "/api/preview/proxy/abc123/entry.js"');
    expect(output).toContain('from "/api/preview/proxy/abc123/module.js"');
    expect(output).toContain('const url = "/api/data"');
    expect(output).toContain('fetch("/api/data")');
  });

  it('adds URL auth tokens to CSS and JavaScript rewritten resources', () => {
    const cssOutput = rewritePreviewBody({
      bodyText: '@import "/theme.css"; .hero { background: url(/hero.png); }',
      kind: 'css',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    });
    const jsOutput = rewritePreviewBody({
      bodyText: 'import("/entry.js"); import value from "/module.js";',
      kind: 'javascript',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    });

    expect(cssOutput).toContain('@import "/api/preview/proxy/abc123/theme.css?yuri_preview_token=preview-secret&yuri_url_token=url-secret"');
    expect(cssOutput).toContain('url(/api/preview/proxy/abc123/hero.png?yuri_preview_token=preview-secret&yuri_url_token=url-secret)');
    expect(jsOutput).toContain('import("/api/preview/proxy/abc123/entry.js?yuri_preview_token=preview-secret&yuri_url_token=url-secret")');
    expect(jsOutput).toContain('from "/api/preview/proxy/abc123/module.js?yuri_preview_token=preview-secret&yuri_url_token=url-secret"');
  });
});

describe('preview redirect URL rewriting', () => {
  it('rewrites loopback redirects through the preview proxy', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:3000/login?next=%2F#top',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
    })).toBe('/api/preview/proxy/abc123/login?next=%2F#top');
  });

  it('leaves external redirects unchanged', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'https://example.com/login',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
    })).toBe('https://example.com/login');
  });

  it('adds proxy auth tokens to loopback redirects when provided', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:3000/login?next=%2F#top',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    })).toBe('/api/preview/proxy/abc123/login?next=%2F&yuri_preview_token=preview-secret&yuri_url_token=url-secret#top');
  });

  it('leaves redirects unchanged when no target origin is provided', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:5174/callback',
      proxyBasePath: '/api/preview/proxy/abc123',
      previewToken: 'preview-secret',
    })).toBe('http://localhost:5174/callback');
  });
});

describe('preview navigation policy', () => {
  const currentUrl = 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/docs';

  it('keeps same-page hash and already-proxied links in the iframe', () => {
    expect(classifyPreviewNavigation({ url: '#section', currentUrl }).action).toBe('allow');
    expect(classifyPreviewNavigation({
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/roadmap',
      currentUrl,
    }).action).toBe('allow');
  });

  it('routes loopback absolute links through the preview proxy', () => {
    expect(classifyPreviewNavigation({ url: 'http://localhost:3000/roadmap', currentUrl })).toEqual({
      action: 'proxy',
      url: 'http://localhost:3000/roadmap',
    });
  });

  it('maps app-origin root links back to the upstream origin while proxied', () => {
    expect(classifyPreviewNavigation({
      url: 'http://127.0.0.1:57123/support',
      currentUrl,
      targetOrigin: 'https://app.example.com',
    })).toEqual({
      action: 'proxy',
      url: 'https://app.example.com/support',
    });
  });

  it('sends non-loopback http links outside the preview iframe', () => {
    expect(classifyPreviewNavigation({ url: 'https://example.com/docs', currentUrl })).toEqual({
      action: 'external',
      url: 'https://example.com/docs',
    });
  });

  it('leaves non-http links to browser defaults', () => {
    expect(classifyPreviewNavigation({ url: 'mailto:test@example.com', currentUrl })).toEqual({
      action: 'allow',
      url: 'mailto:test@example.com',
    });
  });
});

describe('proxy target normalization (SSRF guard)', () => {
  it('allows ordinary external hosts when allowExternal is set', () => {
    expect(normalizeProxyTargetUrl('https://docs.example.com/security/', { allowExternal: true }))
      .toEqual({ ok: true, origin: 'https://docs.example.com' });
  });

  it('rejects non-loopback hosts without allowExternal', () => {
    expect(normalizeProxyTargetUrl('https://example.com/', {}).ok).toBe(false);
  });

  it('refuses private, loopback and link-local literals on the external path', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.16.9.9/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://localhost/',
      'http://service.local/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://2130706433/', // decimal form of 127.0.0.1, normalized by WHATWG URL
    ]) {
      expect(normalizeProxyTargetUrl(url, { allowExternal: true }).ok, url).toBe(false);
    }
  });

  it('still blocks private hosts even via IPv4-mapped IPv6', () => {
    expect(normalizeProxyTargetUrl('http://[::ffff:127.0.0.1]/', { allowExternal: true }).ok).toBe(false);
  });
});

describe('preview CSP rewrite', () => {
  it('drops frame-ancestors and require-trusted-types-for but keeps the rest', () => {
    const result = rewritePreviewCspHeader(
      "default-src 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'",
      'abc123',
    );
    expect(result).not.toContain('frame-ancestors');
    expect(result).not.toContain('require-trusted-types-for');
    expect(result).toContain("default-src 'self'");
  });

  it('adds the nonce to an existing script-src instead of removing it', () => {
    const result = rewritePreviewCspHeader("script-src 'self'", 'abc123');
    expect(result).toContain("script-src 'self' 'nonce-abc123'");
  });

  it('adds the nonce to script-src-elem when present', () => {
    const result = rewritePreviewCspHeader("script-src-elem 'self'", 'abc123');
    expect(result).toContain("script-src-elem 'self' 'nonce-abc123'");
  });

  it('synthesizes script-src from default-src when no script directive exists', () => {
    const result = rewritePreviewCspHeader("default-src 'self' https://cdn.example.com", 'abc123');
    expect(result).toContain("default-src 'self' https://cdn.example.com");
    expect(result).toContain("script-src 'self' https://cdn.example.com 'nonce-abc123'");
  });

  it("drops a lone 'none' so the nonce takes effect", () => {
    const result = rewritePreviewCspHeader("script-src 'none'", 'abc123');
    expect(result).toBe("script-src 'nonce-abc123'");
  });

  it('returns empty/unset CSP values unchanged', () => {
    expect(rewritePreviewCspHeader('', 'abc123')).toBe('');
    expect(rewritePreviewCspHeader(undefined, 'abc123')).toBe(undefined);
  });
});
