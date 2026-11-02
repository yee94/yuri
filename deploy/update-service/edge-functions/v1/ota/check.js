import { handleCapgoOtaCheck } from '../../../lib/ota-check.js';

// Capgo resolves downloads against the same complete EdgeOne deployment.
export async function onRequest({ request }) {
  return handleCapgoOtaCheck(request);
}
