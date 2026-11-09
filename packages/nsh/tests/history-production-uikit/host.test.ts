import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { list, messagesFrom, record, runtimeEventFrom, text } from '../../model';
import { createNativeHistoryRows } from '../../history-rows';
import { appearanceFromSettings } from '../../appearance-core';
import { assistantContacts, assistantScheduledTasks, readAssistantSnapshot } from '../../assistants-core';
import { changeGroups, changesSnapshot, createChangesReader, patchLines } from '../../chat-changes-model';
import { nativeDiffIsNew, nativeDiffLayout } from '../../chat-changes-layout';
import { nativeToolDetails } from '../../transcript-tools-model';
import { extractGitChangedFiles, summarizeGitChangedFiles } from '../../../ui/src/components/chat/changedFiles';
import { runtimeScopeFrom, sameRuntimeScope } from '../../runtime-scope';
import { createLocalCompatibilityPreferences } from '../../local-compatibility-preferences-core';
import { nativeLayoutDensity } from '../../native-density';
import { projectHomeDensityGeometry } from '../../projects-presentation';
import { DEFAULT_GLOBAL_STARTERS, globalStarterRefs, projectStarterLocation, projectStarterConfig, resolveStarters, starterOptions } from '../../new-session-ui-helpers';
import { nativeCommandRows } from '../../composer-commands-model';
import { parseMagicOverrides } from '../../settings-magic-state';
import { acceptBtwIntent, createBtwGenerate, createBtwOwner } from '../../chat-btw-model';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, binary: string;
const expectedHost = { hostID: 'history-production-synthetic', lease: '00000000-0000-4000-8000-000000000053' };
const syntheticTransportID = 'cd9d3a81-277a-4e69-958a-cf789c8b46e3';
const admit = { name: 'connection.list', input: {} };
const request = (path: string, method = 'GET', body?: unknown) => ({ name: 'runtime.request', input: { expectedHost, path, method, ...(body === undefined ? {} : { body }) } });
const dir = 'directory=%2Ffixture%2Fhistory', base = '/api/session/history-production-500';
const newDraftHome = '/fixture/home';
const newDraftConfigPath = projectStarterLocation(newDraftHome, '/fixture/history').path;
const newDraftConfigRead = '/api/fs/read?path=' + encodeURIComponent(newDraftConfigPath) + '&optional=true';
const presetMetadataPath = '/api/config/commands/metadata?' + dir;
const presetSkillsPath = '/api/config/skills?summary=true&' + dir;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'history-production-foundation-')); binary = path.join(temporary, 'host');
  const driver = path.join(temporary, 'Driver.swift');
  writeFileSync(driver, `import Foundation
@main struct Driver {
  static func main() throws {
    let host: HistoryProductionHost
    do { host = try HistoryProductionHost(scenario: CommandLine.arguments[1]) }
    catch { print(String(decoding: try HistoryProductionHost.json(["startupError": error.localizedDescription]), as: UTF8.self)); return }
    host.completeStartupSweep()
    var events: [[String: Any]] = [], tickets: [String: HistoryProductionHost.StreamTicket] = [:]
    host.onEvent = { name, value in events.append(["name": name, "value": value]) }
    let calls = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
    var results: [[String: Any]] = []
    for call in calls {
      if let capture = call["capture"] as? String, let key = call["key"] as? String {
        tickets[capture] = host.streamTicket(key); continue
      }
      if let saved = call["emit"] as? String, let ticket = tickets[saved] {
        if call["output"] as? String == "ready" { host.emit(.ready, ticket: ticket) }
        else if call["output"] as? String == "disconnected" { host.emit(.disconnected, ticket: ticket) }
        else { host.emit(.data(call["data"] as? String ?? "{}"), ticket: ticket) }
        continue
      }
      do { results.append(["ok": true, "value": try host.call(call["name"] as! String, call["input"])]) }
      catch { results.append(["ok": false, "error": error.localizedDescription]) }
    }
    var exchange: Any = NSNull(), audit: Any = NSNull(), duplicateRejected = false
    if host.observerDisabled { audit = try JSONSerialization.jsonObject(with: host.uiParityAuditData()) }
    else {
      let clock = HistoryProductionClock(); try clock.issue("clock-test-0001")
      let reply = try clock.reply(["nonce": "clock-test-0001", "jsSendMs": 100.0])
      let elapsed = (reply["returnedNativeMs"] as! Double) - (reply["receivedNativeMs"] as! Double)
      let ack: [String: Any] = ["nonce": "clock-test-0001", "jsSendMs": 100.0, "jsReceiveMs": 102.0 + elapsed, "receivedNativeMs": reply["receivedNativeMs"]!, "returnedNativeMs": reply["returnedNativeMs"]!]
      exchange = try clock.acknowledge(ack)
      do { _ = try clock.acknowledge(ack) } catch { duplicateRejected = true }
    }
    print(String(decoding: try HistoryProductionHost.json(["results": results, "events": events, "snapshot": host.snapshot, "clock": exchange, "duplicateRejected": duplicateRejected, "uiParityAudit": audit]), as: UTF8.self))
  }
}`);
  const result = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'SyntheticHost.swift'), path.join(root, 'ClockContract.swift'), driver, '-o', binary], { encoding: 'utf8', timeout: 110000 });
  expect(result.status, result.stderr).toBe(0);
}, 120000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
function run(calls: unknown[], scenario = 'terminal', layout?: string, appearance?: string, runMode?: string, density?: string) {
  const env = { ...process.env };
  delete env.HISTORY_SYNTHETIC_DIFF_LAYOUT; delete env.HISTORY_SYNTHETIC_APPEARANCE;
  delete env.HISTORY_SYNTHETIC_RUN_MODE;
  delete env.HISTORY_SYNTHETIC_DENSITY;
  if (layout !== undefined) env.HISTORY_SYNTHETIC_DIFF_LAYOUT = layout;
  if (appearance !== undefined) env.HISTORY_SYNTHETIC_APPEARANCE = appearance;
  if (runMode !== undefined) env.HISTORY_SYNTHETIC_RUN_MODE = runMode;
  if (density !== undefined) env.HISTORY_SYNTHETIC_DENSITY = density;
  const result = spawnSync(binary, [scenario], { input: JSON.stringify(calls), env, encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
it('loads preset commands and skills through the actual dialog loadCatalog and production bindRequest adapter', async () => {
  const calls: Array<{ name: string; input: object }> = [], audits: ReturnType<typeof run>[] = [];
  const runtime: Partial<typeof import('../../runtime')> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, '../../runtime.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: runtime, require: (id: string) => {
      if (id === 'nsh') return { host: { available: () => true, call: async (name: string, input: object) => {
        calls.push({ name, input });
        const response = run([admit, { name, input }], 'normal', undefined, 'reference-105', 'ui-parity'); audits.push(response);
        if (!response.results[1].ok) throw new Error(response.results[1].error);
        return response.results[1].value;
      } } };
      if (id === './model') return { record };
      if (id === './runtime-scope') return { runtimeScopeFrom };
      throw new Error('Unexpected preset runtime dependency ' + id);
    },
  });
  const source = ts.createSourceFile('new-session-page.tsx', readFileSync(path.join(root, '../../new-session-page.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NativeNewSessionStarters')!;
  const functions = ['send', 'loadCatalog'].map(name => {
    const fn = component.body!.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!fn) throw new Error('Missing production preset function ' + name);
    return fn.getText(source);
  }).join('\n');
  const signal = <T,>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
  const commands = signal<ReturnType<typeof record>[]>([]), skills = signal<ReturnType<typeof record>[]>([]), error = signal(''), catalogBusy = signal(false);
  const load = vm.runInNewContext(ts.transpileModule(functions + '\nloadCatalog;', { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, {
    props: { owner: { directory: '/fixture/history' } }, request: runtime.bindRequest!(expectedHost), current: () => true, alive: true, commands, skills, error, catalogBusy, record, t: (key: string) => key,
  }) as () => Promise<void>;
  await load();
  expect(error()).toBe(''); expect(catalogBusy()).toBe(false);
  expect(calls).toEqual([
    { name: 'runtime.request', input: { expectedHost, path: presetMetadataPath, method: 'POST', body: { catalog: true } } },
    { name: 'runtime.request', input: { expectedHost, path: presetSkillsPath, method: 'GET' } },
  ]);
  expect(commands().map(row => row.name)).toEqual(['fixture-command', 'fixture-project-command']);
  for (const command of commands()) expect(Object.keys(command).sort()).toEqual(['agent', 'description', 'isBuiltIn', 'model', 'name', 'reference', 'scope', 'source']);
  expect(commands()[0]).toMatchObject({ isBuiltIn: false, scope: 'user', source: 'command', agent: null, model: null });
  expect(commands()[1]).toMatchObject({ isBuiltIn: false, scope: 'project', reference: '/fixture/history/.opencode/commands/fixture-project-command.md' });
  expect(skills()).toEqual([{ name: 'fixture-review', path: '/fixture/history/.agents/skills/fixture-review/SKILL.md', scope: 'project', source: 'agents', description: 'Synthetic project review skill; catalog only.' }]);
  const options = starterOptions([...DEFAULT_GLOBAL_STARTERS], [], commands(), skills(), key => key);
  expect(options.map(item => [item.ref.name, item.group, item.section])).toEqual([
    ['craft-goal', 'global', 'built-in'], ['fixture-command', 'global', 'command'], ['fixture-project-command', 'project', 'command'], ['fixture-review', 'project', 'skill'],
  ]);
  expect(options.filter(item => `${item.label} ${item.ref.name}`.toLowerCase().includes('review')).map(item => item.ref.name)).toEqual(['fixture-review']);
  for (const audit of audits) {
    expect(audit.snapshot).toMatchObject({ rejected: 0, syntheticBtwGenerateCount: 0, mutations: 0, network: false });
    const events = audit.snapshot.journal.filter((row: { phase: string }) => row.phase === 'synthetic-preset-catalog-read');
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]).sort()).toEqual(['catalog', 'nativeUptimeMs', 'phase', 'requestID', 'rowCount', 'scenario', 'sequence', 'sourceGeneration', 'synthetic']);
  }
  const stable = run([admit, request(presetMetadataPath, 'POST', { catalog: true }), request(presetMetadataPath, 'POST', { catalog: true }), request(presetSkillsPath)], 'normal', undefined, undefined, 'ui-parity');
  expect(stable.results[1].value).toEqual(stable.results[2].value);
});
it('preset catalog rejects nonliteral booleans, alternate query/body/scope and mutations outside explicit normal ui-parity', () => {
  const good = { catalog: true }, sentinel = 'PRIVATE_PRESET_BODY_SENTINEL';
  const bad = [
    ...['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'post'].map(method => request(presetMetadataPath, method, good)),
    ...[undefined, null, [], [good], true, 1, 'true', {}, { catalog: false }, { catalog: 1 }, { catalog: 'true' }, { catalog: [] }, { catalog: {} }, { ...good, names: [] }, { ...good, prompt: sentinel }, { ...good, model: sentinel }].map(body => request(presetMetadataPath, 'POST', body)),
    ...['/api/config/commands/metadata', presetMetadataPath + '&directory=%2Ffixture%2Fhistory', presetMetadataPath + '&extra=1', presetMetadataPath.replace('directory=', 'location%5Bdirectory%5D='), presetMetadataPath.replace('%2Ffixture%2Fhistory', '%2Fother'), presetMetadataPath.replace('%2Ffixture%2Fhistory', '%2Ffixture%2Fhistory%2F..%2Fhistory'), presetMetadataPath.replace('/metadata?', '/metadata/?'), '/api/config/commands/../commands/metadata?' + dir].map(path => request(path, 'POST', good)),
    ...[undefined, { ...expectedHost, hostID: 'other' }, { ...expectedHost, lease: '00000000-0000-4000-8000-000000000054' }, { ...expectedHost, extra: true }].map(scope => ({ name: 'runtime.request', input: { path: presetMetadataPath, method: 'POST', body: good, ...(scope ? { expectedHost: scope } : {}) } })),
    request(presetSkillsPath, 'GET', {}), request(presetSkillsPath, 'POST'), request(presetSkillsPath.replace('summary=true', 'summary=false')), request(presetSkillsPath.replace('summary=true', 'summary=1')), request(presetSkillsPath + '&summary=true'), request(presetSkillsPath.replace('%2Ffixture%2Fhistory', '%2Fother')),
    request('/api/session', 'POST', {}), request(base + '/prompt?' + dir, 'POST', {}), request(base + '/command?' + dir, 'POST', {}), request(base + '/model?' + dir, 'POST', {}), request('/api/config/settings', 'PUT', { draftStarters: [] }), request('/api/fs/write', 'POST', {}), request('/api/fs/mkdir', 'POST', {}), request('/api/small-model/generate', 'POST', {}),
  ];
  const result = run([admit, ...bad], 'normal', undefined, undefined, 'ui-parity');
  expect(result.results.slice(1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.snapshot).toMatchObject({ rejected: bad.length, syntheticBtwGenerateCount: 0, mutations: 0, network: false });
  expect(result.snapshot.journal.some((row: { phase: string }) => row.phase === 'synthetic-preset-catalog-read')).toBe(false);
  expect(JSON.stringify(result.uiParityAudit)).not.toContain(sentinel);
  expect(run([request(presetMetadataPath, 'POST', good)], 'normal', undefined, undefined, 'ui-parity').results[0].ok).toBe(false);
  for (const scenario of ['normal', 'terminal', 'partial', 'growth']) for (const mode of [undefined, 'ui-parity']) {
    if (scenario === 'normal' && mode === 'ui-parity') continue;
    const disabled = run([admit, request(presetMetadataPath, 'POST', good)], scenario, undefined, undefined, mode);
    expect(disabled.results[1].ok).toBe(false);
    expect(disabled.snapshot).toMatchObject({ rejected: 1, mutations: 0, network: false });
  }
});
it('serves fixed synthetic BTW Markdown only in explicit ui-parity with count/requestID metadata and unchanged main session/history', () => {
  const generate = request(base + '/generate', 'POST', { prompt: 'fixture code question' });
  const main = [base + '?' + dir, base + '/message/hp-0497?' + dir];
  const result = run([admit, ...main.map(path => request(path)), generate, generate, ...main.map(path => request(path)), request('/api/fs/home'), request(newDraftConfigRead)], 'normal', undefined, 'reference-105', 'ui-parity');
  expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
  const reply = result.results[3].value;
  expect(reply.status).toBe(200); expect(Object.keys(reply.body)).toEqual(['data']); expect(Object.keys(reply.body.data)).toEqual(['text']);
  expect(reply.body.data.text).toContain('Synthetic BTW fixture only. No model was invoked. 🧪🙂');
  expect(reply.body.data.text).toContain('`let count = 2`'); expect(reply.body.data.text).toContain('```swift\n');
  expect(reply.body.data.text).toContain('Plain text after the code block.');
  expect(result.results[4].value).toEqual(reply);
  expect(result.results[5].value).toEqual(result.results[1].value); expect(result.results[6].value).toEqual(result.results[2].value);
  expect(result.results[7].value.body).toEqual({ home: newDraftHome }); expect(projectStarterConfig(result.results[8].value.body)).toEqual({ projectPath: '/fixture/history', draftStarters: [] });
  const events = result.snapshot.journal.filter((row: { phase: string }) => row.phase === 'synthetic-btw-generate');
  expect(events.map((row: { generateCount: number }) => row.generateCount)).toEqual([1, 2]);
  expect(new Set(events.map((row: { requestID: number }) => row.requestID)).size).toBe(2);
  for (const row of events) expect(result.snapshot.journal.some((entry: { phase: string; requestID: number; method?: string; path?: string }) => entry.phase === 'request' && entry.requestID === row.requestID && entry.method === 'POST' && entry.path === base + '/generate')).toBe(true);
  expect(result.snapshot).toMatchObject({ rejected: 0, messageCount: 500, syntheticBtwGenerateCount: 2, mutations: 0, network: false });
  expect(JSON.stringify(result.uiParityAudit)).not.toContain('fixture code question'); expect(JSON.stringify(result.uiParityAudit)).not.toContain(reply.body.data.text);
});

it('roundtrips the real native bindRequest/createBtwGenerate and owner prompt through the Swift synthetic Host without selection or main prompt writes', async () => {
  const calls: Array<{ name: string; input: object }> = [], audits: ReturnType<typeof run>[] = [];
  const runtime: Partial<typeof import('../../runtime')> = {};
  const js = ts.transpileModule(readFileSync(path.join(root, '../../runtime.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { exports: runtime, require: (id: string) => {
    if (id === 'nsh') return { host: { available: () => true, call: async (name: string, input: object) => {
      calls.push({ name, input });
      const response = run([admit, { name, input }], 'normal', undefined, undefined, 'ui-parity'); audits.push(response);
      expect(response.results[1].ok).toBe(true); return response.results[1].value;
    } } };
    if (id === './model') return { record };
    if (id === './runtime-scope') return { runtimeScopeFrom };
    throw new Error('Unexpected BTW runtime dependency');
  } });
  const scope = { runtime: expectedHost, sessionID: 'history-production-500', directory: '/fixture/history' };
  const generate = createBtwGenerate(scope, runtime.bindRequest!(expectedHost));
  const direct = await generate('fixture code question');
  let resolve!: () => void;
  const completed = new Promise<void>(yes => { resolve = yes; });
  const owner = createBtwOwner(scope, generate, () => true, () => { const status = owner.snapshot().turns[0]?.status; if (status && status !== 'pending') resolve(); });
  expect(acceptBtwIntent(owner, { question: 'fixture code question' }, false)).toBe('accepted');
  await completed;
  expect(owner.snapshot().turns[0]).toMatchObject({ answer: direct, status: 'complete' });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({ name: 'runtime.request', input: { expectedHost, path: base + '/generate', method: 'POST', body: { prompt: 'fixture code question' } } });
  expect(record(record(calls[1].input).body).prompt).toBe('The user is asking a quick side question about the conversation so far. Answer directly and concisely in markdown from what you already know. Do not call any tools and do not take any actions.\n\nfixture code question');
  for (const call of calls) expect(Object.keys(call.input).sort()).toEqual(['body', 'expectedHost', 'method', 'path']);
  for (const audit of audits) expect(audit.snapshot).toMatchObject({ rejected: 0, syntheticBtwGenerateCount: 1, mutations: 0, network: false });
});

it('rejects every non-fixture generate method, query, body, scope, session or diagnostic mode without logging prompt/body values', () => {
  const generatePath = base + '/generate', good = { prompt: 'fixture code question' }, secret = 'PRIVATE_BTW_BODY_SENTINEL';
  const bad = [
    ...['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'post'].map(method => request(generatePath, method, good)),
    ...[undefined, null, {}, [], 'fixture code question', { prompt: true }, { prompt: 1 }, { prompt: '' }, { prompt: secret }, { prompt: 'fixture code question\n' }, { prompt: 'FIXTURE CODE QUESTION' }, { prompt: 'arbitrary prefix\n\nfixture code question' }, { ...good, model: 'fixture' }, { ...good, agent: 'build' }].map(body => request(generatePath, 'POST', body)),
    ...['?' + dir, '?location%5Bdirectory%5D=%2Ffixture%2Fhistory', '?prompt=' + secret, '?extra=' + secret, '?', '?a=1&a=2'].map(query => request(generatePath + query, 'POST', good)),
    ...[undefined, { ...expectedHost, hostID: 'other' }, { ...expectedHost, lease: '00000000-0000-4000-8000-000000000054' }, { ...expectedHost, extra: secret }].map(scope => ({ name: 'runtime.request', input: { path: generatePath, method: 'POST', body: good, ...(scope ? { expectedHost: scope } : {}) } })),
    request('/api/session/other/generate', 'POST', good), request(generatePath + '/', 'POST', good),
    request('/api/session', 'POST', good), request(base + '/prompt', 'POST', good), request(base + '/command', 'POST', good), request(base + '/model', 'PUT', good), request('/api/small-model/generate', 'POST', good),
  ];
  const result = run([admit, ...bad], 'normal', undefined, undefined, 'ui-parity');
  expect(result.results.slice(1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.snapshot).toMatchObject({ rejected: bad.length, syntheticBtwGenerateCount: 0, mutations: 0, network: false });
  expect(result.snapshot.journal.some((row: { phase: string }) => row.phase === 'synthetic-btw-generate')).toBe(false);
  const audit = JSON.stringify(result.uiParityAudit); expect(audit).not.toContain(secret); expect(audit).not.toContain('fixture code question'); expect(audit).not.toContain('"prompt"');
  expect(run([request(generatePath, 'POST', good)], 'normal', undefined, undefined, 'ui-parity').results[0].ok).toBe(false);
  for (const scenario of ['normal', 'terminal', 'partial', 'growth']) {
    expect(run([admit, request(generatePath, 'POST', good)], scenario).results[1].ok).toBe(false);
    if (scenario !== 'normal') expect(run([admit, request(generatePath, 'POST', good)], scenario, undefined, undefined, 'ui-parity').results[1].ok).toBe(false);
  }
});
it('serves the exact new-draft home/config defaults and local inventory across ui-parity profiles without business writes', () => {
  expect(newDraftConfigPath).toBe('/fixture/home/.config/yuri/projects/path_L2ZpeHR1cmUvaGlzdG9yeQ.json');
  const resources = ['/api/fs/home', newDraftConfigRead, '/api/config/settings', '/api/magic-prompts', '/api/command?location%5Bdirectory%5D=%2Ffixture%2Fhistory'];
  for (const density of [undefined, '50', '100', '105', '200']) {
    const result = run([admit, ...resources.map(path => request(path)), request(newDraftConfigRead)], 'normal', undefined, 'reference-105', 'ui-parity', density);
    expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
    const bodies = result.results.slice(1).map((row: { value: { body: unknown } }) => row.value.body);
    expect(bodies[0]).toEqual({ home: newDraftHome });
    expect(bodies[1]).toBe(bodies[5]);
    const project = projectStarterConfig(bodies[1]);
    expect(project).toEqual({ projectPath: '/fixture/history', draftStarters: [] });
    const global = globalStarterRefs(record(bodies[2]));
    expect(global).toEqual(DEFAULT_GLOBAL_STARTERS);
    expect(resolveStarters(global, 'global', [], [], key => key).map(item => item.submitText)).toEqual(['/explore', '/catch-up', '/weigh', '/debug', '/workspace-review']);
    expect(parseMagicOverrides(bodies[3])).toEqual({});
    const commands = list(record(bodies[4]).data), scope = { hostID: expectedHost.hostID, directory: '/fixture/history', draft: 'synthetic-new-draft' };
    const context = { hasSession: false, hasMessages: false, hasNewDraft: true };
    const names = nativeCommandRows(commands, '', scope, key => key, context).map(row => row.command.name);
    expect(names).toEqual(expect.arrayContaining(['new', 'model', 'compact', 'explore', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh']));
    expect(names).not.toContain('summary'); expect(names).not.toContain('init');
    expect(nativeCommandRows(commands, '', scope, key => key, { ...context, hasSession: true, hasMessages: true }).map(row => row.command.name)).toContain('summary');
    expect(result.snapshot).toMatchObject({ rejected: 0, mutations: 0, network: false });
    expect(result.snapshot.journal.filter((row: { phase: string; method?: string }) => row.phase === 'request').every((row: { method: string }) => row.method === 'GET')).toBe(true);
  }
});
it('new-draft reads reject arbitrary files, malformed query/scope/body and all navigation-triggered business writes', () => {
  const paths = ['/api/fs/home?extra=1', '/api/fs/read', '/api/fs/read?path=' + encodeURIComponent(newDraftConfigPath), newDraftConfigRead.replace('optional=true', 'optional=false'),
    newDraftConfigRead + '&optional=true', newDraftConfigRead + '&extra=1', newDraftConfigRead.replace('path=', 'directory='),
    '/api/fs/read?path=%2Ffixture%2Fhistory%2F.yuri%2Fyuri.json&optional=true', '/api/fs/read?path=%2Fprivate&optional=true',
    '/api/fs/read?path=' + encodeURIComponent(newDraftConfigPath.replace('/projects/', '/projects/../projects/')) + '&optional=true',
    '/api/magic-prompts?directory=%2Ffixture%2Fhistory', '/api/command?location%5Bdirectory%5D=%2Fother'];
  const bad = [...paths.map(path => request(path)), ...['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].flatMap(method => [request('/api/fs/home', method), request(newDraftConfigRead, method)]),
    request('/api/fs/home', 'GET', {}), request(newDraftConfigRead, 'GET', null),
    ...[undefined, { ...expectedHost, lease: '00000000-0000-4000-8000-000000000054' }, { ...expectedHost, hostID: 'other' }, { ...expectedHost, extra: true }].map(scope => ({ name: 'runtime.request', input: { path: newDraftConfigRead, method: 'GET', ...(scope ? { expectedHost: scope } : {}) } })),
    request('/api/session', 'POST', {}), request(base + '/prompt?' + dir, 'POST', {}), request(base + '/command?' + dir, 'POST', {}), request(base + '/model?' + dir, 'POST', {}),
    request('/api/small-model/generate', 'POST', {}), request('/api/config/commands/metadata?' + dir, 'POST', { catalog: false })];
  const result = run([admit, ...bad, request('/api/fs/home'), request(newDraftConfigRead)], 'normal', undefined, undefined, 'ui-parity');
  expect(result.results.slice(1, -2).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.results.slice(-2).every((row: { ok: boolean }) => row.ok)).toBe(true);
  expect(result.snapshot).toMatchObject({ rejected: bad.length, mutations: 0, network: false });
  for (const scenario of ['terminal', 'partial', 'growth']) {
    const isolated = run([admit, request('/api/fs/home'), request(newDraftConfigRead)], scenario);
    expect(isolated.results.slice(1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
    expect(isolated.snapshot).toMatchObject({ rejected: 2, mutations: 0, network: false });
  }
});
it('serves the complete root/Chat startup read contract after real connection snapshot admission', () => {
  const resources = ['/api/config/settings', '/api/config/themes', '/api/yuri/session-index', '/api/yuri/assistants/snapshot', '/api/yuri/scheduled-tasks', '/api/session/active', '/api/session-folders/order', '/api/yuri/history-import/jobs', '/api/debug/location', '/api/yuri/message-queue/worktrees/order?projectDirectory=%2Ffixture%2Fhistory', '/api/git/check?' + dir, '/api/git/worktrees?' + dir, '/api/git/status?' + dir + '&mode=light', '/api/config/catalog/providers?' + dir, '/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fhistory', '/api/command?location%5Bdirectory%5D=%2Ffixture%2Fhistory', '/api/permission/request?' + dir, '/api/form?' + dir, base + '?' + dir, base + '/inbox?' + dir, base + '/form?' + dir];
  const result = run([admit, ...resources.map(resource => request(resource)), request('/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Ffixture%2Fhistory', 'POST', { input: { sessionID: 'history-production-500' } }),
    { name: 'runtime.stream', input: { path: '/api/yuri/events', key: 'global', expectedHost } }, { name: 'runtime.stream', input: { path: '/api/event?' + dir, key: 'chat', expectedHost, mode: 'auto', ownerID: 'chat-root-1' } },
    { name: 'notification.launch.peek', input: {} }, { name: 'native.diagnostics.status', input: {} }, { name: 'speech.prepare', input: { owner: 'speech-fixture' } }]);
  expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
  expect(result.snapshot).toMatchObject({ rejected: 0, network: false, mutations: 0, sdkAdoptionIdentity: null });
});
it('preserves the fixed Swift transport UUID through the real connection parser/adopter and opens only its local brand partition', async () => {
  type Snapshot = import('../../runtime').ConnectionSnapshot;
  const runtime: { connections?: () => Promise<Snapshot>; connectionSnapshotFrom?: (value: unknown) => Snapshot } = {};
  let wire: unknown;
  const js = ts.transpileModule(readFileSync(path.join(root, '../../runtime.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { exports: runtime, require: (id: string) => {
    if (id === 'nsh') return { host: { available: () => true, call: async (name: string) => { expect(name).toBe('connection.list'); return wire; } } };
    if (id === './model') return { record };
    if (id === './runtime-scope') return { runtimeScopeFrom };
    throw new Error('Unexpected runtime dependency');
  } });
  for (const scenario of ['normal', 'terminal', 'partial', 'growth']) {
    const result = run([admit, admit], scenario, undefined, undefined, 'ui-parity');
    wire = result.results[0].value;
    expect(result.results[1].value).toEqual(wire);
    const parsed = await runtime.connections!();
    expect(parsed).toEqual({ selected: expectedHost.hostID, runtimeScope: expectedHost, connections: [{ id: expectedHost.hostID, label: 'Synthetic history memory Host', url: 'https://synthetic.invalid', authorizationID: 'history-synthetic-only', transportID: syntheticTransportID, lastUsedAt: 0 }] });
    expect(parsed.connections[0].transportID).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const legacy = { ...parsed, connections: parsed.connections.map(({ transportID: _transportID, ...connection }) => connection) };
    expect(runtime.connectionSnapshotFrom!(legacy).connections[0]).not.toHaveProperty('transportID');
    for (const transportID of ['', null, 'https://synthetic.invalid', 'a/b', 1]) {
      expect(() => runtime.connectionSnapshotFrom!({ ...parsed, connections: [{ ...parsed.connections[0], transportID }] })).toThrow('Invalid connection transport identity');
    }
    const signal = <T,>(initial: T) => { let value = initial; const field = () => value; field.set = (next: T) => { value = next; }; return field; };
    const app = { connection: signal<Snapshot['connections'][number] | null>(null), runtimeScope: signal<Snapshot['runtimeScope']>(null), connections: signal<Snapshot['connections']>([]),
      projects: signal([]), sessions: signal([]), bots: signal([]), tasks: signal([]), online: signal(false), loading: signal(false) };
    const state = ts.createSourceFile('state.ts', readFileSync(path.join(root, '../../state.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const adopt = state.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'adoptConnections');
    expect(adopt).toBeDefined();
    const adopter = vm.runInNewContext(ts.transpileModule(adopt!.getText(state), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText + '\nadoptConnections;', {
      app, sameRuntimeScope, batch: (work: () => void) => work(), reconnectPending: true, pendingRetirement: undefined, generation: 0, connectivityRevision: 0,
      rootErrorActions: { retire() {} },
      historyCache: { clearMemory() {} }, nativeCatalogCache: { clear() {} }, retireCatalog() {}, chatAuthorityRetirements: new Set(), dirtyDomains: new Set(), runtimeReady: signal(false),
    }) as (snapshot: Snapshot) => void;
    adopter(parsed);
    expect(app.connection()).toEqual(parsed.connections[0]); expect(app.runtimeScope()).toEqual(expectedHost);
    const disk = new Map<string, string>();
    const preferences = createLocalCompatibilityPreferences({ get: async key => disk.get(key) ?? null, set: async (key, value) => { disk.set(key, value); } });
    const capture = { transportID: app.connection()!.transportID!, expectedHost: app.runtimeScope()!, current: () => true, currentHost: app.runtimeScope, currentTransportID: () => app.connection()?.transportID ?? null };
    const owner = preferences.openSidebarBrand(capture, () => {});
    expect(await owner.load()).toEqual({ sidebarBrandName: 'Yuri' });
    expect(await owner.save({ sidebarBrandName: 'Synthetic local brand' })).toEqual({ sidebarBrandName: 'Synthetic local brand' });
    owner.dispose();
    expect(await preferences.openSidebarBrand(capture, () => {}).load()).toEqual({ sidebarBrandName: 'Synthetic local brand' });
    expect([...disk.keys()]).toEqual(['sidebar-brand-transport-v1.' + syntheticTransportID]);
    expect(result.snapshot).toMatchObject({ rejected: 0, network: false, mutations: 0 });
  }
  const denied = run([admit, { name: 'runtime.request', input: { path: '/api/config/settings', method: 'GET', expectedHost: { ...expectedHost, transportID: syntheticTransportID } } }], 'normal');
  expect(denied.results[1].ok).toBe(false);
  expect(denied.snapshot).toMatchObject({ rejected: 1, mutations: 0, network: false });
});
it('returns all 500 ordered wire messages in 25 opaque pages and exercises the actual production message/row projection', () => {
  const calls = [admit, request(base + '/message?' + dir + '&limit=20&order=desc'), ...Array.from({ length: 24 }, (_, index) => request(base + '/message?' + dir + '&limit=20&cursor=history.before.' + (480 - index * 20)))];
  for (const [scenario, mode] of [['terminal', undefined], ['normal', undefined], ['normal', 'ui-parity']] as const) {
    const result = run(calls, scenario, undefined, undefined, mode), pages = result.results.slice(1).map((row: { ok: boolean; value: { body: unknown } }) => { expect(row.ok).toBe(true); return messagesFrom(row.value.body, false); });
    const messages = pages.reverse().flatMap((page: ReturnType<typeof messagesFrom>) => page.messages);
    expect(messages).toHaveLength(500); expect(new Set(messages.map((row: { id: string }) => row.id)).size).toBe(500);
    const rows = createNativeHistoryRows()(messages);
    expect(rows.length).toBeGreaterThan(200); expect(rows.some(row => row.messages.length > 1)).toBe(true);
    expect(messages.some((row: { tools: unknown[] }) => row.tools.length > 0)).toBe(true);
    expect(result.snapshot.journal.filter((row: { phase: string }) => row.phase === 'history-response')).toHaveLength(25);
    expect(result.snapshot.journal.at(-2)).toMatchObject({ phase: 'history-response', complete: true, nextCursor: null });
    expect(result.snapshot).toMatchObject({ rejected: 0, mutations: 0, network: false });
  }
});
it('keeps full hide, partial error-clear and body-growth sources separate, with no delayed response gate', () => {
  const page = base + '/message?' + dir + '&limit=20';
  const partial = run([admit, request(page + '&order=desc'), request(page + '&cursor=history.before.480'), request(page + '&cursor=history.before.480')], 'partial');
  expect(partial.results.slice(1).map((row: { value: { status: number } }) => row.value.status)).toEqual([200, 503, 200]);
  expect(partial.snapshot.journal.filter((row: { phase: string }) => row.phase === 'history-response').at(-1)).toMatchObject({ complete: false, nextCursor: 'history.before.460' });
  const growth = run([admit, request(page + '&order=desc'), request(page + '&order=desc'), request(page + '&order=desc')], 'growth');
  const lengths = growth.results.slice(1).map((row: { value: { body: { data: Array<{ id: string; content: Array<{ text?: string }> }> } } }) => row.value.body.data.find(item => item.id === 'hp-0497')!.content[0].text!.length);
  expect(lengths[1]).toBeGreaterThan(lengths[0]); expect(lengths[2]).toBeGreaterThan(lengths[1]);
  const fill = run([admit, request(base + '/message/hp-0499?' + dir)]);
  expect(fill.results[1].value.body.content[1]).toMatchObject({ slim: false });
  expect(fill.results[1].value.body.content[1].state.output.length).toBeGreaterThan(1000);
});
it('fails closed on missing/wrong scope, wrong query/ID, every model/session/Git mutation and native transport attempt', () => {
  const bad = [request(base + '/prompt?' + dir, 'POST', { text: 'synthetic' }), request('/api/session', 'POST', {}), request('/api/small-model/generate', 'POST', {}), request('/api/git/commit?' + dir, 'POST', {}), request('/api/config/settings', 'PUT', {}), request('/api/fs/read?path=%2Fprivate'), request(base + '/message?' + dir + '&limit=20&cursor=history.before.480&order=desc'), request(base + '/message?' + dir + '&limit=20&limit=20'), request(base + '?directory=%2Fother'),
    { name: 'runtime.request', input: { path: '/api/config/settings' } }, { name: 'runtime.request', input: { path: '/api/config/settings', expectedHost: { ...expectedHost, lease: 'old' } } }, { name: 'connection.connect', input: {} }, { name: 'speech.segment', input: { owner: 'speech-fixture' } }];
  const result = run([request('/api/config/settings'), admit, ...bad]);
  expect(result.results[0].ok).toBe(false); expect(result.results.slice(2).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.snapshot.rejected).toBe(bad.length + 1);
});
it('uses live request-local native uptime plus a bounded JS round trip and rejects reused acknowledgements', () => {
  const result = run([admit]);
  expect(result.duplicateRejected).toBe(true);
  expect(result.clock.nativeClock).toBe('ProcessInfo.systemUptime milliseconds');
  expect(result.clock.jsNativeOffsetLowerMs).toBeLessThanOrEqual(result.clock.jsNativeOffsetUpperMs);
  expect(result.clock.nativeAckMs).toBeGreaterThanOrEqual(result.clock.returnedNativeMs);
});

const chatInput = { path: '/api/event?' + dir, key: 'chat', expectedHost, mode: 'auto', ownerID: 'chat-root-1' };
const start = (input: object) => ({ name: 'runtime.stream', input });
const stop = (input: object) => ({ name: 'runtime.stop', input });
const chatStop = { key: 'chat', expectedHost, ownerID: 'chat-root-1' };
it('validates exact start keys, mode, ASCII owner and scope before replacing an admitted ticket', () => {
  const missing = (key: string) => Object.fromEntries(Object.entries(chatInput).filter(([name]) => name !== key));
  const invalid = [
    ...Object.keys(chatInput).map(missing), { ...chatInput, extra: true },
    ...['', 'WS', 'poll', 1, null].map(mode => ({ ...chatInput, mode })),
    ...['', 'a'.repeat(129), 'chat.dot', 'é', 'chat\n', 'chat owner', 7, null].map(ownerID => ({ ...chatInput, ownerID })),
    { ...chatInput, expectedHost: { ...expectedHost, lease: '00000000-0000-4000-8000-000000000054' } },
    { ...chatInput, expectedHost: { ...expectedHost, extra: true } },
    ...['/api/event', '/api/event?directory=', '/api/event?directory=%2Fother', '/api/event?' + dir + '&' + dir, '/api/event?' + dir + '&extra=1', 'https://synthetic.invalid/api/event?' + dir].map(path => ({ ...chatInput, path })),
  ];
  for (const input of invalid) {
    const result = run([admit, start(chatInput), { capture: 'original', key: 'chat' }, start(input), { emit: 'original', data: 'still-current' }], 'normal');
    expect(result.results.map((row: { ok: boolean }) => row.ok), JSON.stringify(input)).toEqual([true, true, false]);
    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toEqual({ name: 'runtime.event', value: { key: 'chat', ownerID: chatInput.ownerID, expectedHost, data: 'still-current' } });
    expect(result.snapshot).toMatchObject({ rejected: 1, mutations: 0, network: false });
  }
  for (const mode of ['auto', 'ws', 'sse']) {
    const result = run([admit, start({ ...chatInput, mode, ownerID: 'A-z_09'.repeat(21) + 'ab' })]);
    expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
    expect(result.events[0].value.type).toBe('reconnected');
  }
});
it('uses owner/scope CAS for stop and suppresses every old-ticket callback, including same-owner replacement', () => {
  const current = { ...chatInput, ownerID: 'chat-root-2', mode: 'ws' };
  const oldScope = { ...expectedHost, lease: '00000000-0000-4000-8000-000000000054' };
  const result = run([admit, start(chatInput), { capture: 'old', key: 'chat' }, start(current), { capture: 'current', key: 'chat' },
    stop(chatStop), stop({ key: 'chat', ownerID: current.ownerID, expectedHost: oldScope }),
    { emit: 'old', output: 'ready' }, { emit: 'old', data: 'late' }, { emit: 'old', output: 'disconnected' },
    { emit: 'current', data: 'current' }, { emit: 'current', output: 'disconnected' },
    start(current), { emit: 'current', data: 'same-owner-late' }, { capture: 'replacement', key: 'chat' },
    stop({ key: 'chat', expectedHost, ownerID: current.ownerID }), { emit: 'replacement', data: 'after-stop' }]);
  expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
  expect(result.events).toEqual([
    { name: 'runtime.event', value: { key: 'chat', ownerID: chatInput.ownerID, expectedHost, type: 'reconnected' } },
    { name: 'runtime.event', value: { key: 'chat', ownerID: current.ownerID, expectedHost, type: 'reconnected' } },
    { name: 'runtime.event', value: { key: 'chat', ownerID: current.ownerID, expectedHost, data: 'current' } },
    { name: 'runtime.disconnected', value: { key: 'chat', ownerID: current.ownerID, expectedHost } },
    { name: 'runtime.event', value: { key: 'chat', ownerID: current.ownerID, expectedHost, type: 'reconnected' } },
  ]);
  expect(result.snapshot).toMatchObject({ rejected: 0, mutations: 0, network: false });
});
it('preserves the global exact contract and rejects malformed cleanup without cancelling the active chat', () => {
  const global = { key: 'global', path: '/api/yuri/events', expectedHost };
  const invalidStops = [
    { key: 'chat', expectedHost }, { ...chatStop, path: chatInput.path }, { ...chatStop, mode: 'ws' },
    { ...chatStop, ownerID: 'invalid.owner' }, { ...chatStop, expectedHost: { ...expectedHost, lease: 'bad' } },
    { key: 'global', expectedHost, ownerID: 'extra' },
  ];
  const result = run([admit, start(chatInput), { capture: 'chat', key: 'chat' }, ...invalidStops.map(stop),
    start(global), { capture: 'old-global', key: 'global' }, start({ ...global, mode: 'auto' }), start({ ...global, ownerID: 'extra' }),
    stop({ key: 'global', expectedHost: { ...expectedHost, hostID: 'old-host' } }), { emit: 'old-global', data: 'global-data' },
    start(global), { emit: 'old-global', data: 'late-global' }, { capture: 'global', key: 'global' },
    stop({ key: 'global', expectedHost }), { emit: 'global', output: 'ready' }, { emit: 'chat', data: 'chat-survives' }, stop(chatStop)]);
  expect(result.snapshot.rejected).toBe(invalidStops.length + 2);
  expect(result.events.map((event: { value: { data?: string } }) => event.value.data).filter(Boolean)).toEqual(['global-data', 'chat-survives']);
  expect(result.events.filter((event: { value: { key: string } }) => event.value.key === 'global')).toEqual([
    { name: 'runtime.event', value: { key: 'global', expectedHost, type: 'reconnected' } },
    { name: 'runtime.event', value: { key: 'global', expectedHost, data: 'global-data' } },
    { name: 'runtime.event', value: { key: 'global', expectedHost, type: 'reconnected' } },
  ]);
});
it('serves settings/theme objects for read-only settings capture and keeps all Host writes closed', () => {
  const result = run([admit, request('/api/config/settings'), request('/api/config/themes'), request('/api/config/settings'), request('/api/config/themes')], 'normal');
  expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
  expect(result.results[2].value.body).toEqual({ themes: [] });
  expect(result.results[1].value.body).toEqual(result.results[3].value.body);
  expect(result.snapshot).toMatchObject({ messageCount: 500, rejected: 0, network: false, mutations: 0 });
  const denied = run([admit, ...['PUT', 'POST', 'PATCH', 'DELETE'].flatMap(method => ['/api/config/settings', '/api/config/themes'].map(path => request(path, method, { codeFontSize: 150 }))) ]);
  expect(denied.results.slice(1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(denied.snapshot.rejected).toBe(8);
});
it('feeds current production event and appearance consumers without an invented runtime.ready event', async () => {
  const data = JSON.stringify({ directory: '/fixture/history', payload: { type: 'session.status', properties: { sessionID: 'history-production-500', status: { type: 'idle' } } } });
  const result = run([admit, start(chatInput), { capture: 'chat', key: 'chat' }, { emit: 'chat', data }, request('/api/config/settings'), request('/api/config/themes')], 'normal');
  expect(result.events.map((event: { name: string }) => event.name)).toEqual(['runtime.event', 'runtime.event']);
  expect(runtimeEventFrom(result.events[0].value)).toMatchObject({ key: 'chat', type: 'reconnected' });
  expect(runtimeEventFrom(result.events[1].value)).toMatchObject({ key: 'chat', type: 'session.status', directory: '/fixture/history', body: { sessionID: 'history-production-500', status: { type: 'idle' } } });
  const appearance = await appearanceFromSettings(result.results[2].value.body, async () => result.results[3].value.body);
  expect(appearance.mode).toBe('system');
  expect(appearance.fontSize).toBe(100);
  expect(result.snapshot).toMatchObject({ rejected: 0, mutations: 0, network: false });
});
it('exposes two synthetic Bots and tasks through production snapshot/settings consumers only in new normal builds', async () => {
  const paths = ['/api/yuri/assistants/capability', '/api/yuri/assistants/snapshot', '/api/yuri/scheduled-tasks', '/api/projects/history-project/scheduled-tasks', '/api/config/catalog/providers', '/api/config/catalog/providers?' + dir];
  const result = run([admit, ...paths.map(path => request(path)), ...[1, 2].flatMap(index => [
    request(`/api/yuri/assistants/outer-bot-${index}/scheduled-tasks`),
    ...['weixin', 'channels/wecom', 'channels/feishu', 'channels/dingtalk'].map(suffix => request(`/api/yuri/assistants/outer-bot-${index}/${suffix}`)),
  ])], 'normal');
  expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
  const snapshot = await readAssistantSnapshot({ current: () => true, request: async () => result.results[2].value.body });
  const contacts = assistantContacts(snapshot.assistants);
  expect(contacts.pinned).toMatchObject({ id: 'outer-bot-1', avatarSeed: 'outer-bot-1', working: true });
  expect(contacts.others).toMatchObject([{ id: 'outer-bot-2', unreadCount: 2 }]);
  // No readTip: this fixture is a display snapshot, not authority to mark a contact read.
  expect(snapshot.assistants.every((bot: object) => !('readTip' in bot))).toBe(true);
  const tasks = result.results[3].value.body.tasks;
  expect(tasks.map((entry: { task: { enabled: boolean } }) => entry.task.enabled)).toEqual([true, false]);
  expect(result.results[4].value.body.tasks).toEqual(tasks.map((entry: { task: unknown }) => entry.task));
  for (let index = 0; index < 2; index++) {
    const mapped = assistantScheduledTasks(result.results[7 + index * 5].value.body);
    expect(mapped.incomplete).toBe(false); expect(mapped.tasks[0].task).toEqual(tasks[index].task);
    expect(result.results[9 + index * 5].value.body).toMatchObject({ provider: 'wecom', configured: false, hasSecret: false });
  }
  expect(result.snapshot).toMatchObject({ synthetic: true, messageCount: 500, rejected: 0, network: false, mutations: 0 });
  for (const scenario of ['terminal', 'partial', 'growth']) {
    const old = run([admit, request(paths[1]), request(paths[2])], scenario);
    expect(old.results[1].value.body).toEqual({ assistants: [] });
    expect(old.results[2].value.body).toEqual({ tasks: [], failedProjectIds: [] });
  }
});
it('audits task and global history pages with issued opaque cursors bound to the exact read scope', () => {
  const path = '/api/yuri/scheduled-task-runs?limit=20';
  for (const owner of ['global', 'outer-task-1', 'outer-task-2']) {
    const scope = owner === 'global' ? '' : `&projectId=history-project&taskId=${owner}`;
    const next = '&before=' + encodeURIComponent(`outer-opaque+/=${owner}-2`);
    const calls = [admit, request(path + scope), request(path + scope + next)];
    if (owner === 'global') calls.push(request(path + scope + '&before=' + encodeURIComponent(`outer-opaque+/=${owner}-4`)));
    const result = run(calls, 'normal');
    expect(result.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
    const pages = result.results.slice(1).map((row: { value: { body: { runs: Array<{ id: string; taskId: string }>; complete: boolean; nextCursor: string | null } } }) => row.value.body);
    const rows = pages.flatMap((page: typeof pages[number]) => page.runs);
    expect(rows).toHaveLength(owner === 'global' ? 6 : 3);
    expect(new Set(rows.map((row: { id: string }) => row.id)).size).toBe(rows.length);
    if (owner !== 'global') expect(rows.every((row: { taskId: string }) => row.taskId === owner)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ complete: true, nextCursor: null });
    expect(result.snapshot.journal.filter((row: { phase: string }) => row.phase === 'outer-history-response')).toHaveLength(pages.length);
    expect(result.snapshot).toMatchObject({ rejected: 0, mutations: 0, network: false });
  }
});
it('rejects guessed/cross-task cursors, malformed outer scope, every business write and unknown Bot/task', () => {
  const history = '/api/yuri/scheduled-task-runs?limit=20', taskScope = '&projectId=history-project&taskId=outer-task-1';
  const bad = [
    request(history + '&before=' + encodeURIComponent('outer-opaque+/=outer-task-1-2')),
    request(history + '&projectId=history-project'), request(history + '&taskId=outer-task-1'),
    request(history + '&projectId=other&taskId=outer-task-1'), request(history + '&projectId=history-project&taskId=unknown'),
    request(history + '&limit=20'), request(history + '&extra=1'), request(history.replace('20', '2')),
    request('/api/yuri/assistants/unknown/scheduled-tasks'), request('/api/yuri/assistants/outer-bot-1/channels/unknown'),
    request('/api/yuri/assistants/snapshot?directory=%2Ffixture%2Fhistory'),
    request('/api/projects/other/scheduled-tasks'), request('/api/projects/history-project/scheduled-tasks?extra=1'),
    request('/api/yuri/assistants/outer-bot-1/channels/feishu', 'GET', {}),
    ...['POST', 'PUT', 'PATCH', 'DELETE'].flatMap(method => [
      '/api/yuri/assistants', '/api/yuri/assistants/outer-bot-1', '/api/yuri/assistants/outer-bot-1/contact/read',
      '/api/yuri/assistants/outer-bot-1/contact/reset', '/api/yuri/assistants/outer-bot-1/channels/feishu',
      '/api/projects/history-project/scheduled-tasks', '/api/projects/history-project/scheduled-tasks/outer-task-1/run',
      '/api/yuri/scheduled-task-runs',
    ].map(path => request(path, method, {}))),
  ];
  const cross = request(history + '&projectId=history-project&taskId=outer-task-2&before=' + encodeURIComponent('outer-opaque+/=outer-task-1-2'));
  const result = run([admit, ...bad, request(history + taskScope), cross, request('/api/yuri/assistants/snapshot'), request('/api/yuri/scheduled-tasks')], 'normal');
  expect(result.results.slice(1, 1 + bad.length).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.results[bad.length + 1].ok).toBe(true); expect(result.results[bad.length + 2].ok).toBe(false);
  expect(result.results.at(-2).value.body.assistants).toHaveLength(2);
  expect(result.results.at(-1).value.body.tasks).toHaveLength(2);
  expect(result.snapshot).toMatchObject({ rejected: bad.length + 1, mutations: 0, network: false });
});

const changedFiles = [
  { path: 'src/staged.txt', staged: true, added: false },
  { path: 'src/working.txt', staged: false, added: false },
  { path: 'docs/new-note.md', staged: false, added: true },
];
it('feeds production workspace reader and composer summary with three dirty files and exact selectable diff bodies', async () => {
  const journal: Array<{ phase: string; path?: string; query?: object; method?: string }> = [];
  const read = async (path: string) => {
    const result = run([admit, request(path)], 'normal');
    expect(result.results[1].ok, path).toBe(true);
    expect(result.snapshot).toMatchObject({ rejected: 0, network: false, mutations: 0 });
    journal.push(...result.snapshot.journal);
    return result.results[1].value.body;
  };
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture/history' }, read);
  await reader.refresh();
  expect(reader.state()).toMatchObject({ gitRepository: true, error: '', snapshot: { isClean: false, current: 'synthetic-changes' } });
  const snapshot = changesSnapshot(reader.state().snapshot);
  expect(changeGroups(snapshot).map(group => [group.staged, group.files.map(file => file.path)])).toEqual([
    [true, ['src/staged.txt']], [false, ['docs/new-note.md', 'src/working.txt']],
  ]);
  expect(summarizeGitChangedFiles(snapshot.files, snapshot.diffStats)).toEqual({ count: 3, insertions: 78, deletions: 6 });
  expect(extractGitChangedFiles(snapshot.files, snapshot.diffStats, '/fixture/history').map(file => [file.relativePath, file.hasStagedChanges, file.hasWorkingChanges])).toEqual([
    ['src/staged.txt', true, false], ['src/working.txt', false, true], ['docs/new-note.md', false, true],
  ]);
  for (const file of changedFiles) {
    await reader.select(file.path, file.staged);
    expect(reader.state().diffError).toBe('');
    expect(reader.state().diff?.after).toContain('WORKSPACE SYNTHETIC');
    expect(reader.state().diff?.after?.split('\n')).toHaveLength(file.added ? 73 : 181);
    expect(nativeDiffIsNew(reader.source, snapshot, file.path, reader.state().diff)).toBe(file.added);
    const wire = await read(`/api/git/diff?${dir}&path=${encodeURIComponent(file.path)}&staged=${file.staged}`);
    const lines = patchLines(wire.diff);
    expect(lines.filter(line => line.kind === 'added')).toHaveLength(file.added ? 72 : 3);
    expect(lines.filter(line => line.kind === 'removed')).toHaveLength(file.added ? 0 : 3);
    await reader.retryDiff(); reader.back(); expect(reader.state().path).toBe('');
  }
  const light = await read('/api/git/status?' + dir + '&mode=light');
  expect(light).toEqual(await read('/api/git/status?' + dir));
  expect(await read('/api/git/check?' + dir)).toEqual({ isGitRepository: true });
  expect(await read('/api/git/remotes?' + dir)).toEqual([]);
  expect(await read('/api/git/worktrees?' + dir)).toEqual([]);
  expect(await read('/api/git/branches?' + dir)).toEqual({ all: ['synthetic-changes'] });
  expect(await read('/api/git/primary-root?' + dir)).toEqual({ root: '/fixture/history' });
  expect(journal.filter(row => row.phase === 'request').every(row => row.method === 'GET')).toBe(true);
});
it('keeps all original history content and hydrates recorded patch tools only from the exact historical changes endpoint', async () => {
  const fill = base + '/message/hp-0499?' + dir;
  const normal = run([admit, request(fill)], 'normal'), original = run([admit, request(fill)], 'terminal');
  const wire = normal.results[1].value.body;
  expect(wire.content.slice(0, 2)).toEqual(original.results[1].value.body.content);
  const projected = messagesFrom({ data: [wire], cursor: { next: null } }, false).messages[0];
  const tool = projected.tools.find(tool => tool.id === 'outer-history-patch');
  expect(tool).toBeDefined();
  const files = nativeToolDetails(tool!).files;
  expect(files.map(file => file.path)).toEqual(changedFiles.map(file => file.path));
  const paths: string[] = [];
  const reader = createChangesReader({ kind: 'turn', directory: '/fixture/history', sessionID: 'history-production-500', messageID: 'hp-0499', files }, async path => {
    paths.push(path);
    const result = run([admit, request(path)], 'normal');
    expect(result.results[1].ok, path).toBe(true);
    expect(result.snapshot).toMatchObject({ rejected: 0, mutations: 0, network: false });
    expect(result.snapshot.journal.find((row: { source?: string }) => row.source === 'historical')).toMatchObject({ phase: 'synthetic-changes-diff', messageID: 'hp-0499' });
    return result.results[1].value.body;
  });
  await reader.refresh(); expect(paths).toEqual([]);
  for (const file of files) {
    await reader.select(file.path);
    expect(reader.state().diffError).toBe('');
    expect(reader.state().diff?.after).toContain('HISTORICAL RECORDED');
    expect(reader.state().diff?.after).not.toContain('WORKSPACE SYNTHETIC');
    expect(reader.state().diff?.patch).toContain('@@');
    expect(nativeDiffIsNew(reader.source, null, file.path, reader.state().diff)).toBe(file.status === 'added');
    reader.back();
  }
  expect(paths).toEqual(changedFiles.map(file => `/api/yuri/sessions/history-production-500/changes?${dir}&messageID=hp-0499&file=${encodeURIComponent(file.path)}`));
});
it('exposes immutable read-only layout profiles and preserves non-normal Git/history scenarios', async () => {
  for (const layout of ['inline', 'side-by-side', 'dynamic'] as const) {
    const result = run([admit, request('/api/config/settings'), request('/api/config/themes'), request('/api/config/settings')], 'normal', layout);
    expect(result.results[1].value.body).toEqual(result.results[3].value.body);
    const appearance = await appearanceFromSettings(result.results[1].value.body, async () => result.results[2].value.body);
    expect(appearance.diffLayoutPreference).toBe(layout);
    expect(nativeDiffLayout(appearance.diffLayoutPreference, 390, false)).toBe(layout === 'side-by-side' ? 'split' : 'unified');
    expect(nativeDiffLayout(appearance.diffLayoutPreference, 1100, false)).toBe(layout === 'inline' ? 'unified' : 'split');
    expect(nativeDiffLayout(appearance.diffLayoutPreference, 1100, true)).toBe(layout === 'side-by-side' ? 'split' : 'unified');
    expect(result.snapshot).toMatchObject({ rejected: 0, network: false, mutations: 0 });
  }
  for (const scenario of ['terminal', 'partial', 'growth']) {
    const result = run([admit, request('/api/git/check?' + dir), request('/api/git/status?' + dir), request(base + '/message/hp-0499?' + dir)], scenario);
    expect(result.results[1].value.body).toEqual({ isGitRepository: false });
    expect(result.results[2].value.body).toEqual({ isGitRepository: false, isClean: true, files: [] });
    expect(result.results[3].value.body.content).toHaveLength(2);
  }
});
it('admits only the fixed reference-105 startup seed, audits active profiles and gives explicit layout precedence', async () => {
  const reference = {
    themeId: 'jetbrains-dark', themeVariant: 'dark', lightThemeId: 'nightowl-light', darkThemeId: 'jetbrains-dark', useSystemTheme: true,
    fontSize: 105, monoFont: 'system-mono', uiFont: 'system', chatRenderMode: 'sorted', diffLayoutPreference: 'dynamic',
  };
  for (const scenario of ['normal', 'terminal', 'partial', 'growth']) {
    const baseline = run([admit, request('/api/config/settings')], scenario);
    expect(baseline.snapshot.activeProfiles).toEqual({ appearance: null, diffLayout: scenario === 'normal' ? 'inline' : null });
    expect(baseline.results[1].value.body).not.toHaveProperty('fontSize');
    const result = run([admit, request('/api/config/settings'), request('/api/config/themes'), request('/api/config/settings')], scenario, undefined, 'reference-105');
    const settings = result.results[1].value.body;
    expect(settings).toEqual({ ...baseline.results[1].value.body, ...reference });
    expect(result.results[3].value.body).toEqual(settings);
    expect(settings).not.toHaveProperty('messageStreamTransport'); expect(settings).not.toHaveProperty('padding');
    const appearance = await appearanceFromSettings(settings, async () => result.results[2].value.body);
    expect(appearance).toMatchObject({ mode: 'system', themeIDs: { light: 'nightowl-light', dark: 'jetbrains-dark' }, fontSize: 105, padding: 100, messageStreamTransport: 'auto', diffLayoutPreference: 'dynamic' });
    expect(result.snapshot).toMatchObject({ activeProfiles: { appearance: 'reference-105', diffLayout: 'dynamic' }, rejected: 0, mutations: 0, network: false });
    expect(result.snapshot.journal.filter((row: { phase: string }) => row.phase === 'synthetic-appearance-read')).toMatchObject([
      { activeProfiles: { appearance: 'reference-105', diffLayout: 'dynamic' } }, { activeProfiles: { appearance: 'reference-105', diffLayout: 'dynamic' } },
    ]);
    for (const layout of ['inline', 'side-by-side', 'dynamic']) {
      const combined = run([admit, request('/api/config/settings')], scenario, layout, 'reference-105');
      expect(combined.results[1].value.body).toEqual({ ...settings, diffLayoutPreference: layout });
      expect(combined.snapshot.activeProfiles).toEqual({ appearance: 'reference-105', diffLayout: layout });
    }
  }
  const denied = run([admit, request('/api/config/settings', 'PUT', reference), request('/api/config/settings')], 'normal', undefined, 'reference-105');
  expect(denied.results[1].ok).toBe(false);
  expect(denied.results[2].value.body).toMatchObject(reference);
  expect(denied.snapshot).toMatchObject({ rejected: 1, mutations: 0, network: false });
});
it('rejects unknown, empty or JSON startup profiles before admission instead of falling back', () => {
  for (const appearance of ['', 'reference-100', 'REFERENCE-105', '{"fontSize":105}', 'reference-105\n']) {
    const result = run([admit, request('/api/config/settings')], 'normal', undefined, appearance);
    expect(result).toEqual({ startupError: 'history_fixture_appearance_profile' });
  }
  for (const layout of ['', 'split', '{"diffLayoutPreference":"dynamic"}']) {
    expect(run([admit], 'normal', layout, 'reference-105')).toEqual({ startupError: 'history_fixture_diff_layout' });
  }
});
it('projects only the four fixed ui-parity density settings through real appearance and layout geometry without changing font or other source data', async () => {
  for (const scenario of ['normal', 'terminal', 'partial', 'growth']) {
    const baseline = run([admit, request('/api/config/settings'), request('/api/config/themes')], scenario, undefined, 'reference-105', 'ui-parity');
    const seed = baseline.results[1].value.body;
    expect(seed).not.toHaveProperty('padding'); expect(baseline.snapshot.activeProfiles).not.toHaveProperty('density');
    for (const density of ['50', '100', '105', '200']) {
      const result = run([admit, request('/api/config/settings'), request('/api/config/settings')], scenario, undefined, 'reference-105', 'ui-parity', density);
      const settings = result.results[1].value.body, padding = Number(density), scale = Math.sqrt(padding / 100);
      expect(settings).toEqual({ ...seed, padding }); expect(result.results[2].value.body).toEqual(settings);
      expect(typeof settings.padding).toBe('number');
      const appearance = await appearanceFromSettings(settings, async () => baseline.results[2].value.body);
      expect(appearance).toMatchObject({ padding, fontSize: 105, diffLayoutPreference: 'dynamic', messageStreamTransport: 'auto' });
      const layout = nativeLayoutDensity(appearance.padding), projects = projectHomeDensityGeometry(appearance.padding);
      expect(layout.scale).toBe(scale);
      expect(layout.settings.card.padding).toBeCloseTo(16 * scale);
      expect(layout.select.content.padding).toBeCloseTo(16 * scale);
      expect(layout.pages.sheetEditor.padding).toBeCloseTo(20 * scale);
      expect(layout.chat.input.maxHeight).toBeCloseTo(104 * scale);
      expect(layout.settings.field.minHeight).toBeGreaterThanOrEqual(44);
      expect(projects.headerHeight).toBeCloseTo(74 * scale);
      expect(projects).toMatchObject({ pageInset: 18, radius: 24, groupRadius: 16, title: { fontSize: 14 } });
      expect(result.snapshot).toMatchObject({ activeProfiles: { appearance: 'reference-105', diffLayout: 'dynamic', density: padding }, rejected: 0, mutations: 0, network: false });
      expect(result.uiParityAudit.host.activeProfiles.density).toBe(padding);
      expect(result.snapshot.journal.filter((row: { phase: string }) => row.phase === 'synthetic-density-read')).toMatchObject([{ density: padding }, { density: padding }]);
    }
    const defaultSeed = run([admit, request('/api/config/settings')], scenario);
    expect(defaultSeed.results[1].value.body).not.toHaveProperty('padding');
    expect(defaultSeed.snapshot.activeProfiles).not.toHaveProperty('density');
  }
  const combined = run([admit, request('/api/config/settings')], 'normal', 'side-by-side', 'reference-105', 'ui-parity', '200');
  expect(combined.results[1].value.body).toMatchObject({ padding: 200, fontSize: 105, diffLayoutPreference: 'side-by-side', themeId: 'jetbrains-dark' });
  const plain = run([admit, request('/api/config/settings')], 'normal', undefined, undefined, 'ui-parity', '200');
  expect(plain.results[1].value.body).not.toHaveProperty('fontSize');
  expect(plain.results[1].value.body.padding).toBe(200);
});
it('rejects malformed density profiles and diagnostic mode use while keeping padding GET schema and every business PUT closed', () => {
  for (const density of ['', '49', '201', '050', '+50', '50.0', ' 50', '50 ', '200\n', 'null', '{"padding":200}']) {
    expect(run([admit], 'normal', undefined, undefined, 'ui-parity', density)).toEqual({ startupError: 'history_fixture_density_profile' });
  }
  for (const density of ['50', '100', '105', '200']) {
    expect(run([admit], 'normal', undefined, undefined, undefined, density)).toEqual({ startupError: 'history_fixture_density_requires_ui_parity' });
  }
  const result = run([admit, request('/api/config/settings', 'PUT', { padding: 50 }), request('/api/config/settings?padding=200'), request('/api/config/settings', 'GET', { padding: 200 }), request('/api/config/settings')], 'normal', undefined, 'reference-105', 'ui-parity', '200');
  expect(result.results.slice(1, -1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.results.at(-1).value.body).toMatchObject({ padding: 200, fontSize: 105, diffLayoutPreference: 'dynamic' });
  expect(result.snapshot).toMatchObject({ rejected: 3, mutations: 0, network: false });
});
it('admits only explicit ui-parity, keeps default diagnostic mode and reports no clock or strict history admission', () => {
  const baseline = run([admit, request('/api/config/settings')], 'normal');
  expect(baseline.snapshot).toMatchObject({ runMode: 'history-diagnostic', observerDisabled: false });
  expect(baseline.clock).not.toBeNull(); expect(baseline.uiParityAudit).toBeNull();
  const calls = [{ name: 'history.qa.ready', input: {} }, admit, request('/api/config/settings'), request('/api/yuri/assistants/snapshot'), request('/api/yuri/scheduled-tasks'), request('/api/git/status?' + dir), request(base + '/message/hp-0499?' + dir)];
  const ui = run(calls, 'normal', undefined, 'reference-105', 'ui-parity');
  expect(ui.results.every((row: { ok: boolean }) => row.ok)).toBe(true);
  expect(ui.results[0].value).toEqual({ available: false, runMode: 'ui-parity', observerDisabled: true, strictAcceptance: false, historyDriverAdmission: false });
  expect(ui.clock).toBeNull(); expect(ui.duplicateRejected).toBe(false);
  expect(ui.snapshot).toMatchObject({ runMode: 'ui-parity', observerDisabled: true, activeProfiles: { appearance: 'reference-105', diffLayout: 'dynamic' }, rejected: 0, network: false, mutations: 0 });
  expect(ui.uiParityAudit).toMatchObject({ sourceSynthetic: true, runMode: 'ui-parity', observerDisabled: true, strictAcceptance: false, historyDriverAdmission: false,
    diagnosticsAvailable: { clock: false, mark: false, prepareAX: false, readAX: false, capture: false }, host: ui.snapshot });
  expect(ui.uiParityAudit).not.toHaveProperty('frames'); expect(ui.uiParityAudit).not.toHaveProperty('clock');
  const diagnostic = run(calls.slice(1), 'normal', undefined, 'reference-105');
  expect(ui.results.slice(1)).toEqual(diagnostic.results);
  for (const mode of ['', 'history-diagnostic', 'UI-PARITY', 'ui-parity\n', '{"runMode":"ui-parity"}']) {
    expect(run([admit], 'normal', undefined, undefined, mode)).toEqual({ startupError: 'history_fixture_run_mode' });
  }
});
it('denies diagnostic calls, missing/wrong scopes and business writes in ui-parity without fake acknowledgements', () => {
  const bad = [
    { name: 'history.qa.ready', input: { nonce: 'not-a-ready-ack' } },
    ...['history.qa.clock', 'history.qa.clockAck', 'history.qa.mark', 'history.qa.prepareAX', 'history.qa.readAX'].map(name => ({ name, input: {} })),
    { name: 'runtime.request', input: { path: '/api/config/settings' } },
    { name: 'runtime.request', input: { path: '/api/config/settings', expectedHost: { ...expectedHost, lease: 'old' } } },
    request('/api/config/settings', 'PUT', { fontSize: 105 }), request('/api/git/commit?' + dir, 'POST', {}),
  ];
  const result = run([admit, ...bad, request('/api/config/settings')], 'normal', undefined, undefined, 'ui-parity');
  expect(result.results.slice(1, -1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.results.at(-1).ok).toBe(true);
  expect(result.snapshot).toMatchObject({ rejected: bad.length, mutations: 0, network: false });
  expect(result.clock).toBeNull();
});
it('bounds long-running ui-parity journal memory and audit bytes while retaining cumulative rejection and truncation evidence', () => {
  const huge = '/unlisted-' + 'x'.repeat(5000);
  const result = run([admit, request(huge), ...Array.from({ length: 1500 }, () => request('/api/config/themes'))], 'normal', undefined, undefined, 'ui-parity');
  const audit = result.uiParityAudit;
  expect(result.results.slice(2).every((row: { ok: boolean }) => row.ok)).toBe(true);
  expect(audit.host.journal.length).toBeLessThanOrEqual(128);
  expect(audit.journalBytes).toBeLessThanOrEqual(32768);
  expect(Buffer.byteLength(JSON.stringify(audit))).toBeLessThanOrEqual(49152);
  expect(audit.host.journal.every((entry: object) => Buffer.byteLength(JSON.stringify(entry)) <= 2048)).toBe(true);
  expect(audit.host).toMatchObject({ journalOverflow: true, rejected: 1, mutations: 0, network: false });
  expect(audit.host.journalDropped).toBeGreaterThan(0);
  expect(audit.host.journalSequence).toBeGreaterThan(3000);
  expect(audit.host.journal.at(-1).sequence).toBe(audit.host.journalSequence);
  const omitted = run([admit, request(huge)], 'normal', undefined, undefined, 'ui-parity');
  expect(omitted.snapshot.journal.some((row: { phase: string }) => row.phase === 'ui-parity-entry-omitted')).toBe(true);
  expect(JSON.stringify(omitted.uiParityAudit)).not.toContain(huge);
});
it('keeps the fixture native startup installations/grants intact and creates Observer only in the diagnostic branch', () => {
  const source = readFileSync(path.join(root, 'main.swift'), 'utf8');
  expect(source).toContain('NativeInputMetadataOwner.install(on: surface)');
  expect(source).toContain('NativeComposerSpellcheck.install(on: surface)');
  expect(source).toMatch(/if host\.observerDisabled \{[\s\S]+?\} else \{\s+observer = try HistoryProductionObserver\(surface: surface, host: host\)/);
  expect(source.match(/HistoryProductionObserver\(surface:/g)).toHaveLength(1);
  expect(source).toContain('ui_parity_requires_fresh_artifact');
  expect(source).toContain('HistoryProductionHost.uiParityControlMethods');
  expect(source).toContain('writeUIParityAudit(trigger: "startup")');
  expect(source).toContain('writeUIParityAudit(trigger: "background")');
  expect(source).toContain('appendingPathComponent("ui-parity-audit.json"), options: .atomic');
  expect(source).toContain('surface.grantCapabilities(String(decoding: Data(contentsOf: configURL), as: UTF8.self))');
  expect(source).not.toMatch(/CADisplayLink|DispatchSource|Timer\(|onRecord\s*=|removeItem|write.*"(?:ready|capture|control-ack|clock-ack)\.json"/);
  const build = readFileSync(path.join(root, 'build.mjs'), 'utf8');
  for (const method of ['history.qa.ready', 'history.qa.clock', 'history.qa.clockAck']) expect(build).toContain(`'${method}'`);
  expect(build).not.toContain('history.qa.audit');
});
it('executes the actual production modelCatalog for host-global and exact workspace reads without invented root directories', async () => {
  const source = ts.createSourceFile('features.tsx', readFileSync(path.join(root, '../../features.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'modelCatalog');
  expect(declaration).toBeDefined();
  const js = ts.transpileModule(declaration!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const signal = <T,>(initial: T) => { let value = initial; const field = () => value; field.set = (next: T) => { value = next; }; return field; };
  const catalogFactory = vm.runInNewContext(js + '\nmodelCatalog;', { signal, record, list, text, query: (directory: string) => `directory=${encodeURIComponent(directory)}`,
    unwrap: (value: unknown) => record(value).data ?? value, t: (key: string) => key, failureMessage: (value: unknown) => String(value) }) as
    (state: { current: () => boolean; interactive: () => boolean; request: (path: string) => Promise<unknown> }, initial: object, includeAgent: boolean) =>
      { load: (directory: string | null) => Promise<void>; error: () => string; agents: () => Array<{ id: string }>; providers: () => Array<{ id: string }> };
  for (const mode of [undefined, 'ui-parity']) {
    for (const directory of [null, '/fixture/history']) {
      for (const includeAgent of [false, true]) {
        const paths: string[] = [];
        const catalog = catalogFactory({ current: () => true, interactive: () => true, request: async path => {
          paths.push(path);
          const result = run([admit, request(path)], 'normal', undefined, undefined, mode);
          expect(result.results[1].ok, path).toBe(true);
          expect(result.snapshot).toMatchObject({ rejected: 0, mutations: 0, network: false });
          return result.results[1].value.body;
        } }, { providerID: 'fixture', modelID: 'gpt-fixture' }, includeAgent);
        await catalog.load(directory);
        expect(catalog.error()).toBe('');
        expect(catalog.providers().map(provider => provider.id)).toEqual(['fixture']);
        expect(catalog.agents().map(agent => agent.id)).toEqual(includeAgent ? ['build'] : []);
        expect(paths).toEqual([
          '/api/config/catalog/providers' + (directory === null ? '' : '?' + dir),
          ...(includeAgent ? ['/api/agent' + (directory === null ? '' : '?location%5Bdirectory%5D=%2Ffixture%2Fhistory')] : []),
        ]);
      }
    }
  }
  const bad = ['/api/agent?', '/api/agent?directory=%2Ffixture%2Fhistory', '/api/agent?location%5Bdirectory%5D=',
    '/api/agent?location%5Bdirectory%5D=%2Fother', '/api/agent?extra=1',
    '/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fhistory&extra=1',
    '/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fhistory&location%5Bdirectory%5D=%2Ffixture%2Fhistory', '/api/agents', '/api/agent/'];
  const rejected = run([admit, ...bad.map(path => request(path))], 'normal', undefined, undefined, 'ui-parity');
  expect(rejected.results.slice(1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(rejected.snapshot).toMatchObject({ rejected: bad.length, mutations: 0, network: false });
  for (const scenario of ['terminal', 'partial', 'growth']) expect(run([admit, request('/api/agent')], scenario).results[1].ok).toBe(false);
});
it('replays actual runtime binding for settings/themes and diagnoses missing scope without relaxing the read authority gate', async () => {
  const calls: Array<{ name: string; input: object }> = [];
  const runtime: { bindRequest?: (scope: typeof expectedHost | null) => (path: string) => Promise<unknown> } = {};
  const js = ts.transpileModule(readFileSync(path.join(root, '../../runtime.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { exports: runtime, require: (id: string) => {
    if (id === 'nsh') return { host: { available: () => true, call: async (name: string, input: object) => { calls.push({ name, input }); return { status: 200, body: {} }; } } };
    if (id === './model') return { record };
    if (id === './runtime-scope') return { runtimeScopeFrom };
    throw new Error('Unexpected runtime dependency');
  } });
  const capturedWithoutScope = runtime.bindRequest!(null);
  await capturedWithoutScope('/api/config/settings');
  const capturedWithScope = runtime.bindRequest!(expectedHost);
  await capturedWithScope('/api/config/settings'); await capturedWithScope('/api/config/themes');
  // A later valid owner does not mutate the earlier captured request's authority.
  await capturedWithoutScope('/api/config/settings');
  expect(calls.map(call => Object.keys(call.input).sort())).toEqual([
    ['method', 'path'], ['expectedHost', 'method', 'path'], ['expectedHost', 'method', 'path'], ['method', 'path'],
  ]);
  const result = run([admit, ...calls], 'normal', undefined, 'reference-105', 'ui-parity');
  expect(result.results.map((row: { ok: boolean }) => row.ok)).toEqual([true, false, true, true, false]);
  const rejected = result.snapshot.journal.filter((row: { phase: string }) => row.phase === 'rejected');
  expect(rejected).toHaveLength(2);
  for (const row of rejected) expect(row).toMatchObject({ name: 'runtime.request', code: 'history_fixture_arguments', path: '/api/config/settings', method: 'GET',
    knownKeys: ['method', 'path'], missingRequiredKeys: ['expectedHost'], unknownKeyCount: 0, scopeKnownKeys: [], scopeUnknownKeyCount: 0 });
  expect(result.snapshot).toMatchObject({ rejected: 2, mutations: 0, network: false });
});
it('records only bounded allowlisted request metadata for schema/scope rejections, never headers or argument values', () => {
  const secret = 'SENSITIVE_SENTINEL_NOT_TO_BE_LOGGED';
  const bad = [
    { path: '/api/config/settings?token=' + secret, method: 'GET', headers: { Authorization: secret }, [secret]: secret },
    { path: '/api/config/themes', method: 'GET', expectedHost: { ...expectedHost, token: secret } },
    { path: '/api/config/settings', method: secret, expectedHost: { ...expectedHost, lease: secret } },
    { path: 'https://user:' + secret + '@private.invalid/path', method: 'GET', body: { token: secret } },
    { path: '/api/config/settings', method: 'GET', expectedHost: { hostID: secret, lease: expectedHost.lease } },
  ];
  const result = run([admit, ...bad.map(input => ({ name: 'runtime.request', input }))], 'normal', undefined, undefined, 'ui-parity');
  expect(result.results.slice(1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  const rows = result.snapshot.journal.filter((row: { phase: string }) => row.phase === 'rejected');
  expect(rows).toHaveLength(bad.length);
  expect(rows[0]).toMatchObject({ path: '/api/config/settings', method: 'GET', knownKeys: ['method', 'path'], missingRequiredKeys: ['expectedHost'], unknownKeyCount: 2 });
  expect(rows[1]).toMatchObject({ path: '/api/config/themes', scopeKnownKeys: ['hostID', 'lease'], scopeUnknownKeyCount: 1 });
  expect(rows[2].method).toBe('<invalid>'); expect(rows[3].path).toBe('<unlisted>');
  const encoded = JSON.stringify(result.uiParityAudit);
  expect(encoded).not.toContain(secret); expect(encoded).not.toContain('Authorization'); expect(encoded).not.toContain('headers');
  expect(result.snapshot).toMatchObject({ rejected: bad.length, mutations: 0, network: false });
});
it('fails closed on invalid Changes queries, historical scope, all Git writes and model generation', () => {
  const reads = [
    '/api/git/status?' + dir + '&mode=full', '/api/git/status?' + dir + '&extra=1',
    '/api/git/file-diff?' + dir + '&path=src%2Fstaged.txt&staged=false',
    '/api/git/file-diff?' + dir + '&path=docs%2Fnew-note.md&staged=true',
    '/api/git/file-diff?' + dir + '&path=unknown&staged=false',
    '/api/git/file-diff?' + dir + '&path=src%2Fworking.txt&staged=0',
    '/api/git/file-diff?path=src%2Fworking.txt&staged=false',
    '/api/git/file-diff?' + dir + '&path=src%2Fworking.txt&staged=false&staged=false',
    '/api/git/remotes?' + dir + '&extra=1', '/api/git/branches', '/api/git/primary-root?directory=%2Fother',
    '/api/yuri/sessions/history-production-500/changes?' + dir + '&messageID=hp-0498&file=src%2Fworking.txt',
    '/api/yuri/sessions/other/changes?' + dir + '&messageID=hp-0499&file=src%2Fworking.txt',
    '/api/yuri/sessions/history-production-500/changes?' + dir + '&messageID=hp-0499&file=unknown',
    '/api/yuri/sessions/history-production-500/changes?' + dir + '&file=src%2Fworking.txt',
    '/api/yuri/sessions/history-production-500/changes?' + dir + '&messageID=hp-0499&file=src%2Fworking.txt&staged=false',
    base + '/diff?' + dir + '&messageID=hp-0499',
    '/api/git/file-diff?directory=%2Fother&path=src%2Fworking.txt&staged=false',
  ];
  const writes = ['stage', 'unstage', 'discard', 'revert', 'commit', 'fetch', 'pull', 'push', 'worktrees'].flatMap(name => ['POST', 'PUT', 'PATCH', 'DELETE'].map(method => request(`/api/git/${name}?${dir}`, method, {})));
  const calls = [...reads.map(path => request(path)), request('/api/git/status?' + dir, 'GET', {}), ...writes,
    request('/api/config/settings', 'PUT', { diffLayoutPreference: 'side-by-side' }), request('/api/small-model/generate', 'POST', {})];
  const result = run([admit, ...calls, request('/api/git/status?' + dir)], 'normal');
  expect(result.results.slice(1, -1).every((row: { ok: boolean }) => !row.ok)).toBe(true);
  expect(result.results.at(-1).value.body).toMatchObject({ isClean: false, files: expect.arrayContaining([{ path: 'src/staged.txt', index: 'M', working_dir: ' ' }]) });
  expect(result.snapshot).toMatchObject({ rejected: calls.length, mutations: 0, network: false });
});
