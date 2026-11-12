import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Run one explicitly requested phase, after normal UI navigation to Web/native.
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const phase = process.argv[3];
if (plan.ready !== true || plan.confirmIsolated !== true || !['web', 'native'].includes(plan.owner) || !/^[a-zA-Z0-9-]+$/.test(plan.label)) throw new Error('Explicit ready isolated owner plan required');
if (!['focus', 'software', 'hid', 'dismiss', 'navigation', 'background'].includes(phase)) throw new Error('Unknown targeted phase');
const evidence = path.resolve(plan.evidence);
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json'), 'utf8'));
const label = `${plan.label}-${plan.owner}-${phase}`;
const output = path.join(evidence, `${label}.json`);
if (fs.existsSync(output)) throw new Error('Refusing phase overwrite');
const env = { ...process.env, REMOTE_PROJECTS_IOS_EVIDENCE: evidence };
const report = { classification: 'diagnostic', owner: plan.owner, phase, startedAt: Date.now(), status: 'blocked', steps: [], limitations: ['LLDB pauses exclude performance claims.', 'Private keyboard runtime getters are diagnostic read-only, not product logic.', 'This phase is not the original remote E2E or 64-story acceptance.'] };
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
const must = (ok, message) => { if (!ok) throw new Error(message); };
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bundleHash = directory => {
  const rows = [];
  const visit = current => {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) visit(file);
      else rows.push([path.relative(directory, file), item.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : hash(file)]);
    }
  };
  visit(directory);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};
const run = (script, ...args) => {
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, [`scripts/remote-projects/${script}.mjs`, ...args], { env, encoding: 'utf8', timeout: 150000, maxBuffer: 10000000 });
  report.steps.push({ script, args, startedAt, completedAt: Date.now(), exitCode: r.status }); save();
  must(r.status === 0, `${script} failed; inspect existing probe/AX/command artifacts`);
};
const probe = suffix => {
  const name = `${label}-${suffix}`;
  run('ios-input-probe', name);
  const raw = JSON.parse(fs.readFileSync(path.join(evidence, `probe-${name}.json`), 'utf8'));
  let field;
  if (plan.owner === 'web') field = raw.web?.inputs.find(n => n.tag === 'TEXTAREA' && n.placeholder === plan.fieldLabel);
  else {
    const views = raw.native?.views ?? [];
    must(views.some(n => n.class.includes('YuriComposer') && !n.hidden && n.alpha > 0), 'Actual native composer not observed');
    const candidates = views.filter(n => n.class.includes('TextView') && !n.hidden && n.alpha > 0);
    must(candidates.length === 1, 'Native editable field ambiguous');
    field = candidates[0];
  }
  must(field, 'Expected actual owner field missing');
  const observed = { file: `probe-${name}.json`, epochMs: raw.native.epochMs, length: plan.owner === 'web' ? field.valueLength : field.textLength,
    focused: plan.owner === 'web' ? raw.web.active?.tag === 'TEXTAREA' && raw.web.active.placeholder === plan.fieldLabel : field.firstResponder,
    start: plan.owner === 'web' ? field.start : field.selectionStart, end: plan.owner === 'web' ? field.end : field.selectionEnd,
    keyboard: raw.native.keyboardRuntimeReadOnly };
  report[suffix] = observed; save(); return observed;
};
const tap = label => { must(typeof label === 'string' && label.length > 0, 'Exact observed AX label required'); run('ios-accessibility', 'tap', label); };
try {
  must(state.deviceName?.startsWith('Yuri Remote Projects Perf ') && !state.cleanedUp, 'Dedicated live task device required');
  must(state.buildStatus === 'built' && /^[a-f0-9]{64}$/.test(plan.sourceHash), 'New frozen native build required');
  must(plan.sourceHash === state.sourceHash, 'Native workspace source hash mismatch');
  report.sourceHash = plan.sourceHash;
  const installed = spawnSync('xcrun', ['simctl', 'get_app_container', state.udid, state.bundleId, 'app'], { env: { ...env, DEVELOPER_DIR: state.developerDir }, encoding: 'utf8', timeout: 15000 });
  must(installed.status === 0 && installed.stdout.includes(state.udid), 'Cannot resolve dedicated installed App');
  const installedApp = installed.stdout.trim();
  report.artifacts = [];
  // Debug Swift can live in App.debug.dylib rather than the App launcher.
  // Hash the entire signed bundle, including dylibs, frameworks and web assets.
  for (const [role, directory] of [['built-app-bundle', state.appPath], ['installed-app-bundle', installedApp]]) {
    const sha256 = bundleHash(directory); report.artifacts.push({ role, sha256 });
    must(sha256 === plan.appBundleSha256, `${role} mismatch, including Swift debug dylib/assets`);
  }
  for (const [role, file, expected] of [
    ['built-native-executable', path.join(state.appPath, 'App'), plan.executableSha256],
    ['installed-native-executable', path.join(installedApp, 'App'), plan.executableSha256],
    ['installed-web-index', path.join(installedApp, 'public/index.html'), plan.webIndexSha256],
  ]) {
    const sha256 = hash(file); report.artifacts.push({ role, sha256 });
    must(sha256 === expected, `${role} mismatch; never claim old installed Swift as new`);
  }
  const before = probe('before');
  if (phase === 'focus') {
    must(before.length === 0 && !before.focused, 'Focus case requires empty unfocused actual composer');
    if (plan.fieldAXMode === 'value') run('ios-accessibility', 'tap-value', plan.fieldAXValue ?? plan.fieldLabel);
    else tap(plan.fieldLabel);
    await delay(500);
    const after = probe('after'); must(after.focused && after.length === 0, 'Ordinary focus was revoked');
  } else if (phase === 'software') {
    must(before.focused && before.length === 0 && before.keyboard?.isInHardwareKeyboardMode === false, 'Software case needs fresh focused empty software-keyboard session');
    tap('Q'); const q = probe('q'); must(q.focused && q.length === 1, 'Actual software Q not retained');
    tap('delete'); const deleted = probe('deleted'); must(deleted.focused && deleted.length === 0, 'Actual software delete failed');
    tap('Q'); const after = probe('after'); must(after.focused && after.length === 1, 'Software Q repeat failed');
  } else if (phase === 'hid') {
    must(before.focused && before.length === 1 && before.keyboard?.isInHardwareKeyboardMode === false, 'HID case must start immediately after software Q, before HID transition');
    run('ios-serve', 'type', 'e'); await delay(500);
    const after = probe('after');
    must(after.keyboard?.isInHardwareKeyboardMode === true, 'No observed software→hardware transition; trigger unverified');
    must(after.focused && after.length === 2, 'First HID character lost or editing revoked');
  } else if (phase === 'dismiss') {
    must(before.focused && before.length === plan.expectedLength, 'Dismiss precondition mismatch');
    tap(plan.dismissLabel); await delay(500);
    const after = probe('after'); must(!after.focused && after.length === before.length, 'User dismiss did not end editing losslessly');
  } else if (phase === 'navigation') {
    must(before.length === plan.expectedLength, 'Navigation draft precondition mismatch');
    tap(plan.leaveLabel); await delay(500); run('ios-input-probe', `${label}-away`);
    if (plan.returnAXMode === 'prefix') run('ios-accessibility', 'tap-prefix', plan.returnLabel);
    else tap(plan.returnLabel);
    await delay(500);
    const after = probe('after'); must(after.length === before.length && after.focused === plan.expectedReturnFocus, 'Normal navigation restore differs from owner contract');
  } else {
    must(before.length === plan.expectedLength, 'Background draft precondition mismatch');
    run('ios-serve', 'home'); await delay(1000); run('ios-input-probe', `${label}-background`);
    run('ios-device', 'foreground'); await delay(1000);
    const after = probe('after'); must(after.length === before.length && after.focused === plan.expectedReturnFocus, 'Background recovery differs from owner contract');
  }
  report.status = 'observed-targeted-behavior';
} catch (error) { report.error = error.message; report.status = 'failed-or-blocked'; process.exitCode = 2; }
report.completedAt = Date.now(); save();
console.log(JSON.stringify({ phase, owner: plan.owner, status: report.status, error: report.error, output }));
