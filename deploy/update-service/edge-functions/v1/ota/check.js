import { handleCapgoOtaCheck } from '../../../lib/ota-check.js';

// Channel manifests ship with this EdgeOne deployment (CI commits them to git),
// so they are read from this host first; the Vercel origin is only the fallback
// when the local copy is missing (bundle URLs in the response stay relative to
// the client-facing request origin).
export async function onRequest({ request, env }) {
  if (!env?.YURI_OTA_UPSTREAM_ORIGIN) return new Response('Yuri update origin is not configured', { status: 503 });
  return handleCapgoOtaCheck(request, {
    manifestBaseUrl: env.YURI_OTA_UPSTREAM_ORIGIN,
    localManifestBaseUrl: new URL(request.url).origin,
  });
}
