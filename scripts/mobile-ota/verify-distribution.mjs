#!/usr/bin/env node
import { verifyOtaDistribution } from '../../deploy/update-service/scripts/ota-distribution.mjs';

let snapshotDirectory;
let baseUrl;
let requireLocal = false;
let requireCurrentCode = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--require-local') requireLocal = true;
  else if (arg === '--require-current-code') requireCurrentCode = true;
  else if (arg === '--snapshot') snapshotDirectory = process.argv[++i];
  else if (arg === '--base') baseUrl = process.argv[++i];
  else throw new Error(`Unknown argument: ${arg}`);
}
if (!snapshotDirectory || !baseUrl) throw new Error('--snapshot and --base are required');

// Git-triggered EdgeOne builds hydrate all retained ZIPs before activation.
// Retry until that complete deployment is visible, never accept the old proxy.
const attempts = requireLocal ? 30 : 1;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const timings = await verifyOtaDistribution({ baseUrl, snapshotDirectory, requireLocal, requireCurrentCode });
    console.log(JSON.stringify({ origin: new URL(baseUrl).origin, local: requireLocal, bundles: timings }, null, 2));
    break;
  } catch (error) {
    if (attempt === attempts) throw error;
    console.error(`OTA distribution not ready (${attempt}/${attempts}): ${error.message}; retrying in 15s`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}
