import { handleOtaProxyRequest } from '../../lib/ota-proxy.js';

// Legacy fallback for /ota/* paths absent from the complete static snapshot.
// CHANGELOG is static-only; do not add an exact function route beside it.
export async function onRequest({ request, env }) {
  return handleOtaProxyRequest(request, { upstreamOrigin: env?.YURI_OTA_UPSTREAM_ORIGIN });
}
