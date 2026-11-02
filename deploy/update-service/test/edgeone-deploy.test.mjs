import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { test } from 'vitest';
import { checkEdgeOneDeployHook, triggerEdgeOneDeploy } from '../../../scripts/mobile-ota/trigger-edgeone-deploy.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hook = 'https://deploy.example.com/hooks/fixture';

test('explicitly posts to the configured hook without following redirects or exposing its response', async () => {
  const calls = [];
  const result = await triggerEdgeOneDeploy({ hook, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ deploymentId: 'fixture', privateUrl: hook }), { status: 202 });
  } });
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, hook);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('rejects missing or unsafe configuration before sending a deployment request', async () => {
  for (const value of [undefined, '', 'not a URL', 'http://deploy.example.com/hooks/fixture',
    'https://user:password@deploy.example.com/hooks/fixture', `${hook}#fragment`]) {
    assert.throws(() => checkEdgeOneDeployHook(value), /YURI_EDGEONE_DEPLOY_HOOK/);
    await assert.rejects(() => triggerEdgeOneDeploy({ hook: value, fetchImpl: () => {
      assert.fail('invalid configuration must not reach the network');
    } }), /YURI_EDGEONE_DEPLOY_HOOK/);
  }
  assert.equal(checkEdgeOneDeployHook(hook), hook);
});

test('HTTP and transport failures fail closed, hide the hook and never blindly replay a POST', async () => {
  for (const status of [301, 401, 429, 500]) {
    let calls = 0;
    await assert.rejects(() => triggerEdgeOneDeploy({ hook, fetchImpl: async () => {
      calls += 1;
      return new Response(hook, { status });
    } }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(hook));
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(() => triggerEdgeOneDeploy({ hook, fetchImpl: async () => {
    throw new Error(`request failed: ${hook}`);
  } }), error => {
    assert.match(error.message, /EdgeOne deployment request failed/);
    assert.ok(!error.message.includes(hook));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test.each([
  ['release.yml', 'mobile-native-targets'],
  ['mobile-beta-ota.yml', 'deploy'],
  ['mobile-beta-rollout.yml', 'rollout'],
])('%s validates hook configuration before publication and explicitly triggers before verification', async (file, jobName) => {
  const workflow = parse(await readFile(path.join(root, '.github/workflows', file), 'utf8'));
  const job = workflow.jobs[jobName];
  assert.equal(job.env.EDGEONE_DEPLOY_HOOK, '${{ secrets.YURI_EDGEONE_DEPLOY_HOOK }}');
  const preflight = job.steps.findIndex(step => step.run?.includes('trigger-edgeone-deploy.mjs --check'));
  const publish = job.steps.findIndex(step => step.run?.includes('vercel@latest deploy'));
  const trigger = job.steps.findIndex(step => step.run?.includes('commit-edgeone-manifests.sh'));
  const verify = job.steps.findIndex(step => step.run?.includes('verify-distribution.mjs'));
  assert.ok(preflight >= 0 && preflight < publish);
  assert.ok(publish < trigger && trigger < verify);
  assert.ok(job.steps[verify].run.includes('--require-local'));
});

test('service changes test the hook and inherit its secret without recursive manifest-only deployment', async () => {
  const workflow = parse(await readFile(path.join(root, '.github/workflows/update-service.yml'), 'utf8'));
  assert.ok(workflow.on.push.paths.includes('scripts/mobile-ota/trigger-edgeone-deploy.mjs'));
  assert.ok(workflow.on.push.paths.includes('!deploy/update-service/ota/channels/**'));
  assert.equal(workflow.jobs.deploy.secrets, 'inherit');
  assert.equal(workflow.jobs.deploy.with.verify_current_code, true);
});

test.each(['changed', 'unchanged', 'push-failed', 'missing-hook', 'hook-failed'])('manifest publication uses an explicit hook for %s without invoking real git', async scenario => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yuri-edgeone-trigger-test-'));
  try {
    const bin = path.join(dir, 'bin');
    const snapshot = path.join(dir, 'snapshot');
    const log = path.join(dir, 'calls');
    await mkdir(bin);
    await mkdir(path.join(snapshot, 'ota/channels'), { recursive: true });
    for (const channel of ['beta', 'stable']) await writeFile(path.join(snapshot, `ota/channels/${channel}.json`), '{}');
    await writeFile(path.join(bin, 'git'), `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$PROBE_LOG"
if [[ "$1 $2" == "worktree add" ]]; then mkdir -p "$5"; fi
if [[ "$1" == "-C" && "$3" == "diff" ]]; then [[ "$SCENARIO" == "unchanged" ]]; exit; fi
if [[ "$1" == "-C" && "$3" == "push" && "$SCENARIO" == "push-failed" ]]; then exit 1; fi
`, { mode: 0o755 });
    await writeFile(path.join(bin, 'node'), `#!/usr/bin/env bash
printf 'node %s\\n' "$*" >> "$PROBE_LOG"
if [[ "$SCENARIO" == "hook-failed" && "$2" != "--check" ]]; then exit 1; fi
[[ -n "$EDGEONE_DEPLOY_HOOK" ]]
`, { mode: 0o755 });
    await writeFile(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const run = () => exec('bash', ['scripts/mobile-ota/commit-edgeone-manifests.sh', snapshot, 'test'], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: `${dir}/`,
        EDGEONE_DEPLOY_HOOK: scenario === 'missing-hook' ? '' : hook, EDGEONE_FORCE_DEPLOY: '', PROBE_LOG: log, SCENARIO: scenario },
    });
    if (['push-failed', 'missing-hook', 'hook-failed'].includes(scenario)) await assert.rejects(run);
    else await run();
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(calls[0], 'node scripts/mobile-ota/trigger-edgeone-deploy.mjs --check');
    const triggers = calls.filter(line => line === 'node scripts/mobile-ota/trigger-edgeone-deploy.mjs');
    assert.equal(triggers.length, ['changed', 'unchanged', 'hook-failed'].includes(scenario) ? 1 : 0);
    if (scenario === 'missing-hook') assert.ok(!calls.some(line => line.startsWith('git ')));
    if (scenario === 'changed') assert.ok(calls.findIndex(line => line.includes(' push ')) < calls.indexOf(triggers[0]));
    if (scenario === 'hook-failed') assert.equal(calls.filter(line => line.includes(' push ')).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
