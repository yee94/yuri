import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

// Channel manifests ship with this EdgeOne deployment (CI commits them to git),
// so they are read from this host first and only fall back to the Vercel origin
// when the local copy is missing. CHANGELOG.md is not emitted on EdgeOne (a
// static file would shadow its proxy function) and /ota/bundles/* is proxied,
// so release notes always come from the authoritative Vercel origin (bundle
// URLs in the response stay relative to the client-facing request origin).
export async function onRequest({ request, env }) {
  if (!env?.YURI_OTA_UPSTREAM_ORIGIN) return new Response('Yuri update origin is not configured', { status: 503 });
  return handleMobileUpdateCheck(request, {
    manifestBaseUrl: env.YURI_OTA_UPSTREAM_ORIGIN,
    localManifestBaseUrl: new URL(request.url).origin,
  });
}
