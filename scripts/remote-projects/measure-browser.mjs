import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const origin = new URL(option('url'));
if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || !args.includes('--confirm-isolated-test')) {
  throw new Error('Use only an explicitly isolated loopback production test UI');
}
if (origin.username || origin.password || [...origin.searchParams.keys()].some(key => /token|secret|password|auth|key/i.test(key))) {
  throw new Error('Do not pass or persist credentials in measurement URLs');
}
for (const name of ['selector', 'build', 'dataset-hash', 'scenario']) if (!option(name)) throw new Error(`--${name}=... required`);
const out = resolve(option('out') ?? '.scratch/remote-projects/performance/browser-typing.json');
const source = readFileSync(new URL('./browser-probe.js', import.meta.url), 'utf8');
const config = { url: origin.href, selector: option('selector'), build: option('build'), datasetHash: option('dataset-hash'),
  scenario: option('scenario'), source, out, space: option('space') ? Number(option('space')) : 'remote-projects-independent-performance' };
const script = `
const config = ${JSON.stringify(config)};
const fs = await import('node:fs/promises');
const task = await taskSpace(config.space);
console.log(JSON.stringify({spaceId: task.spaceId}));
const page = task.page('p1');
await page.cdp('Page.addScriptToEvaluateOnNewDocument', {source: config.source});
await page.goto(config.url);
await page.waitForSelector(config.selector, {state: 'visible'});
console.log(await page.snapshot());
const state = await page.evaluate(selector => {
  const nodes = document.querySelectorAll(selector);
  if (nodes.length !== 1 || !(nodes[0] instanceof HTMLTextAreaElement)) throw new Error('Need exactly one real composer textarea');
  if (nodes[0].value) throw new Error('Refusing to overwrite existing draft');
  return {userAgent: navigator.userAgent, viewport: {width: innerWidth, height: innerHeight}, hardwareConcurrency: navigator.hardwareConcurrency};
}, config.selector);
await page.focus(config.selector);
await page.evaluate(({scenario, selector}) => remoteProjectsPerformance.scenario(scenario, selector), config);
for (let i = 0; i < 50; i++) {
  await page.keyboard.type('x');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))));
}
const raw = await page.evaluate(() => remoteProjectsPerformance.snapshot());
if (raw.samples.filter(s => s.event === 'input' && s.trusted).length < 50) throw new Error('Fewer than 50 trusted input events');
const incompleteDispatchSamples = raw.samples.filter(s => s.synchronousDispatchMs === null).length;
const report = {schemaVersion: 1, phase: 'diagnostic', runtime: 'browser-diagnostic', production: true,
  build: config.build, datasetHash: config.datasetHash, scenario: config.scenario, environment: state, incompleteDispatchSamples, raw,
  warning: 'Browser diagnostic only. Not Electron/iOS, not an IME/paste/undo test, not input-to-paint evidence, and no performance gate is marked passed.'};
await fs.writeFile(config.out, JSON.stringify(report, null, 2)+'\\n');
await task.finish({keep: []});
`;
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(join(resolve(out, '..'), 'browser-typing-command.mjs'), script);
const result = spawnSync('ego-browser', ['nodejs', '-e', script], { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
