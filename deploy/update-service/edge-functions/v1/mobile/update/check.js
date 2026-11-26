import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

// Complete deployments carry manifests, ZIPs and CHANGELOG locally. The
// GitHub supplies ZIPs at build time only.
export async function onRequest({ request }) {
  return handleMobileUpdateCheck(request);
}
