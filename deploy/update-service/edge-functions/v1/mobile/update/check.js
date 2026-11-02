import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

// Complete deployments carry manifests, ZIPs and CHANGELOG locally. The
// upstream is a build-time source, never a dependency of this update check.
export async function onRequest({ request }) {
  return handleMobileUpdateCheck(request);
}
