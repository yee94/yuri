import { OTA_BUNDLE_RELEASE_BASE_URL } from '../../lib/ota-bundle-release.js';
import { handleOtaProxyRequest } from '../../lib/ota-proxy.js';

// Legacy fallback for /ota/* paths absent from the complete static snapshot.
// CHANGELOG is static-only; do not add an exact function route beside it.
export async function onRequest({ request }) {
  return handleOtaProxyRequest(request, {
    bundleBaseUrl: OTA_BUNDLE_RELEASE_BASE_URL,
  });
}
