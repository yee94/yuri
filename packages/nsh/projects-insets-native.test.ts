import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import ts from 'typescript';
import { withProjectsNativeFixture } from './tests/projects-native-runner.js';

test.each(['empty', 'visible', 'absent'] as const)('actual Home Projects Tab gives ProjectsHome full width with a %s history-task entry', taskState => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(root, 'application.tsx'), 'utf8');
  const ast = ts.createSourceFile('application.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const surface = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProjectsHomeSurface')!;
  const home = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Home')!;
  let tab: ts.JsxElement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'View' && node.openingElement.getText(ast).includes("display: app.tab() === 0")) tab = node;
    ts.forEachChild(node, visit);
  };
  visit(home); expect(tab).toBeDefined();
  withProjectsNativeFixture(root, 'home', (fixture: { directory: string; entry: string; host: string }) => {
    writeFileSync(path.join(fixture.directory, fixture.entry), `
import { mount, signal, Text, View } from 'nsh';
import { ProjectsHome } from ${JSON.stringify(path.join(root, 'projects'))};
import { ProjectsHomeSheet } from ${JSON.stringify(path.join(root, 'projects-home-sheet'))};
import { app } from ${JSON.stringify(path.join(root, 'state'))};
import { projectsFixtureAdmission } from ${JSON.stringify(path.join(root, 'tests/projects-fixture-admission'))};
const noop = () => {};
const projectsNavigation = { onOpenChat: noop, onOpenProject: noop, onOpenFiles: noop, onOpenChanges: noop, onAddProject: noop, onEditProject: noop };
const nav = { routes: () => [{}], push: noop };
const tabBarHeight = signal(0), tourHistoryMonitor = signal(${taskState === 'absent' ? 'null' : '{ current: () => true }'});
// Match the real task entry's conditional footprint; task data/lifecycle belong to its own owner.
function NativeHistoryImportTaskEntry() { return <If when={${taskState === 'visible'}}><View class="min-h-11"><Text>Visible synthetic task entry</Text></View></If>; }
${surface.getText(ast)}
function Fixture() {
  const admission = projectsFixtureAdmission(() => app.projects.set([{ id: 'p', name: 'Home entry geometry', path: '/repo' }]));
  return <View class="flex-1 flex-col"><If when={admission.ready()}>${tab!.getText(ast)}</If></View>;
}
mount(Fixture);`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host, '--trace'], { cwd: fixture.directory, encoding: 'utf8', timeout: 45000, input: 'await app.waitFor("id:projects-menu-p"); await app.setViewport(402, 874);' });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    const frames = new Map<number, { x: number; width: number }>(), ids = new Map<string, number>();
    for (const line of (result.stdout + result.stderr).split('\n')) {
      const identity = /ViewProps \{ id: (\d+),.*test_id: Some\("([^"]+)"\)/.exec(line);
      if (identity) ids.set(identity[2], Number(identity[1]));
      const frame = /Frame \{ id: (\d+), x: (-?[\d.]+), y: -?[\d.]+, w: ([\d.]+)/.exec(line);
      if (frame) frames.set(Number(frame[1]), { x: Number(frame[2]), width: Number(frame[3]) });
    }
    expect(frames.get(ids.get('projects-home-scroll')!)?.width, 'actual Home entry Scroll viewport').toBe(402);
    expect(frames.get(ids.get('projects-card-p')!)?.width, 'actual Home entry card').toBe(366);
  });
}, 60000);

test('inset carrier captures all three actual NSH layout variants without a Host', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-insets-geometry-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Insets geometry headless', id: 'example.nsh.insets.headless', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['fixture.insets.report'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/projects-insets-uikit/fixture.tsx'))};`);
    writeFileSync(path.join(directory, 'Geometry.test.ts'), `
import { open, expect, test } from 'nsh/test';
test('402pt metadata parity', async () => {
  let report = null;
  const app = await open('./App.tsx', { width: 402, height: 874, host: { params: { mode: 'minimal' }, handlers: { 'fixture.insets.report': data => { report = data; return {}; } } } });
  await app.waitFor('id:minimal-content-padding-card');
  await app.host.send('fixture.insets.capture');
  await app.waitUntil(() => report !== null);
  for (const variant of ['original', 'split', 'content-padding']) {
    const name = 'minimal-' + variant + '-card';
    const measure = report.measurements.find(row => row.key === name).measurement;
    expect(measure.pagePosition.x).toBe(18); expect(measure.bounds.size.width).toBe(366);
    expect(report.events[name].size.width).toBe(366);
  }
});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Geometry.test.ts'], { cwd: directory, encoding: 'utf8', timeout: 60000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 90000);

test('native report reader rejects a stale bundle identity instead of reporting geometry success', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-insets-report-'));
  try {
    const file = path.join(directory, 'report.json'); writeFileSync(file, JSON.stringify({ snapshots: [{ bundleID: 'example.old-build', buildID: 'old', applicationActive: true }] }));
    const result = spawnSync('node', [path.join(root, 'tests/projects-insets-uikit/read-report.mjs'), file, 'example.new-build'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Wrong/inactive/incomplete/errored capture');
    expect(readFileSync(file, 'utf8')).toContain('example.old-build');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('full report reader requires the actual ProjectsHome consumer marker, not merely the bundle identity', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-insets-consumer-'));
  try {
    const file = path.join(directory, 'report.json');
    writeFileSync(file, JSON.stringify({ schema: 2, bundleID: 'example.current-build', expectedConsumerMarker: 'frozen-source', observedConsumerMarker: '', consumerMarkerMatches: false, snapshots: [] }));
    const result = spawnSync('node', [path.join(root, 'tests/projects-insets-uikit/read-full-report.mjs'), file, 'example.current-build'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('ProjectsHome packed-source consumption unproven');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
