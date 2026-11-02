import { handleOtaProxyRequest } from '../lib/ota-proxy.js';

// Legacy fallback only. Complete EdgeOne deployments intentionally shadow this
// route with the verified static CHANGELOG from the same OTA snapshot.
export async function onRequest({ request, env }) {
  return handleOtaProxyRequest(request, { upstreamOrigin: env?.YURI_OTA_UPSTREAM_ORIGIN });
}
