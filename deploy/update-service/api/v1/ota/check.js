export const config = { runtime: 'edge' };

import { OTA_BUNDLE_RELEASE_BASE_URL } from '../../../lib/ota-bundle-release.js';
import { handleCapgoOtaCheck } from '../../../lib/ota-check.js';

export default async function handler(request) {
  return handleCapgoOtaCheck(request, { bundleBaseUrl: OTA_BUNDLE_RELEASE_BASE_URL });
}
