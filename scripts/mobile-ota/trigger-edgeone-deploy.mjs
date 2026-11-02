#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export function checkEdgeOneDeployHook(hook) {
  let url;
  try { url = new URL(hook); } catch { /* Report configuration without exposing the credential URL. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('YURI_EDGEONE_DEPLOY_HOOK must contain the production main-branch HTTPS deployment hook');
  }
  return url.href;
}

export async function triggerEdgeOneDeploy({ hook, fetchImpl = fetch }) {
  const url = checkEdgeOneDeployHook(hook);
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    // A timeout may still have started a build. Do not replay the POST or expose
    // a fetch error containing the secret URL; retry the complete rollout.
    throw new Error('EdgeOne deployment request failed; retry the rollout after checking its deployment status');
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`EdgeOne deployment request rejected (HTTP ${response.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') {
      checkEdgeOneDeployHook(process.env.EDGEONE_DEPLOY_HOOK);
    } else if (args.length === 0) {
      await triggerEdgeOneDeploy({ hook: process.env.EDGEONE_DEPLOY_HOOK });
      console.log('EdgeOne deployment requested; the full distribution verification gate must still pass.');
    } else {
      throw new Error('Only --check is supported');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
