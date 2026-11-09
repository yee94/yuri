import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Main owns the serial NSH/UIKit window. This file is deliberately not run by the features worker.
it('memory-only production editors preserve unknown receipts, pick models and execute task overflow', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const steps = [
    'let dialogAnswer = ""; let dialogAnswers = 0;',
    'app.onDialog(dialog => { expect(dialog.buttons).toContain(dialogAnswer); dialogAnswers++; console.log("[features-dialog-phase] answer", dialogAnswers, "button-index", dialog.buttons.indexOf(dialogAnswer)); return dialogAnswer; });',
    'await app.waitFor("id:features-memory-ready");',
    'console.log("[features-phase] memory authority ready; model preferences next");',
    'expect(app.texts().join("\\n")).not.toContain("Memory-only fixture Host required");',
    'await app.press("id:features-memory-open-bot"); await app.waitFor("id:features-bot-name");',
    'await app.waitUntil(() => app.enabled("id:features-model-picker")); await app.press("id:features-model-picker"); await app.waitUntil(() => app.enabled("id:features-model-all-fixture-model"));',
    'await app.press("id:features-favorite-all-fixture-model");',
    'await app.waitUntil(() => app.enabled("id:features-effort-all-fixture-model")); await app.press("id:features-effort-all-fixture-model"); await app.waitFor("id:features-variant-all-fixture-model-more");',
    'await app.press("id:features-variant-all-fixture-model-more"); await app.waitFor("id:features-variant-option-high");',
    'await app.press("id:features-variant-option-high"); await app.waitUntil(() => !app.shows("id:features-model-sheet"));',
    'await app.waitUntil(() => app.enabled("id:features-bot-save"));',
    'console.log("[features-phase] model picker dismissed; Bot writes and receipt recovery next");',
    'await app.press("id:features-bot-save"); await app.waitFor("id:features-memory-ready");',
    'console.log("[features-phase] existing Bot save completed; lost-ACK create next");',
    'await app.press("id:features-memory-lose-bot"); await app.waitFor("id:features-bot-name");',
    'await app.waitUntil(() => app.enabled("id:features-bot-save")); await app.type("id:features-bot-name", "Created durable"); await app.press("id:features-bot-save"); await app.waitFor("id:features-write-uncertain");',
    'console.log("[features-phase] create receipt unknown observed; discard and reopen next");',
    'dialogAnswer = "Discard"; await app.back(); await app.waitFor("id:features-memory-ready");',
    'console.log("[features-phase] unknown create editor left; restoring persisted receipt next");',
    'await app.press("id:features-memory-open-new-bot"); await app.waitFor("id:features-write-uncertain");',
    'console.log("[features-phase] reopened create receipt unknown restored; explicit ID verification next");',
    'expect(app.value("id:features-bot-name")).toBe("Created durable");',
    'dialogAnswer = "Created durable · memory-bot-2 · fixture/model"; await app.press("id:features-bot-save"); await app.waitFor("id:features-memory-ready");',
    'console.log("[features-phase] explicit created Bot ID verified without replay");',
    'await app.press("id:features-memory-open-task"); await app.waitUntil(() => app.enabled("id:features-task-more"));',
    'console.log("[features-phase] task actions and history next");',
    'dialogAnswer = "Run now"; await app.press("id:features-task-more"); await app.waitFor("text:Schedule started");',
    'await app.waitUntil(() => app.enabled("id:features-task-more"));',
    'console.log("[features-phase] run action settled; History menu next");',
    'dialogAnswer = "History"; const historyDialogsBefore = app.dialogs().length; const historyAnswersBefore = dialogAnswers; await app.press("id:features-task-more");',
    'expect(app.dialogs().length).toBe(historyDialogsBefore + 1); expect(dialogAnswers).toBe(historyAnswersBefore + 1);',
    'await app.waitFor("id:features-history-close");',
    'console.log("[features-phase] editor History mounted; first opaque page next");',
    'await app.waitUntil(() => app.enabled("id:features-history-more"));',
    'await app.press("id:features-history-more"); await app.waitFor("id:features-history-run-memory-history-3"); await app.press("id:features-history-close");',
    'await app.waitUntil(() => !app.shows("id:features-history-more"));',
    'await app.waitUntil(() => !app.shows("id:features-history-close"));',
    'await app.waitUntil(() => app.enabled("id:features-task-more"));',
    'console.log("[features-phase] history older page verified and closed; Pause next");',
    'dialogAnswer = "Pause"; await app.press("id:features-task-more"); await app.waitFor("text:Schedule saved");',
    'await app.waitUntil(() => app.enabled("id:features-task-more"));',
    'await app.back(); await app.waitFor("id:features-memory-ready");',
    'await app.press("id:features-memory-lose-task"); await app.waitFor("id:features-task-name"); await app.type("id:features-task-name", "Restored task"); await app.press("id:features-task-save"); await app.waitFor("id:features-write-uncertain");',
    'const taskName = app.value("id:features-task-name"); dialogAnswer = "Discard"; await app.back(); await app.waitFor("id:features-memory-ready");',
    'await app.press("id:features-memory-open-task"); await app.waitFor("id:features-write-uncertain"); expect(app.value("id:features-task-name")).toBe(taskName);',
    'await app.press("id:features-task-save"); await app.waitFor("id:features-memory-ready");',
    'await app.press("id:features-memory-audit"); await app.waitUntil(() => app.texts().some(value => value.startsWith("{\\"auditSequence\\":")));',
    'const audit = JSON.parse(app.texts().find(value => value.startsWith("{\\"auditSequence\\":")));',
    'expect(audit.requests.filter(call => call.method === "POST" && call.path === "/api/yuri/assistants").length).toBe(1);',
    'expect(audit.requests.filter(call => call.method === "POST" && call.path.endsWith("/run")).length).toBe(1);',
    'expect(audit.requests.filter(call => call.method === "PATCH" && call.path === "/api/projects/project/scheduled-tasks").length).toBe(2);',
    'expect(audit.settings.favoriteModels.length).toBe(1); expect(audit.settings.recentModels[0].variant).toBe("high");',
  ].join('\n');
  const fixtureDirectory = path.join(directory, 'tests/features-write');
  const engineDirectory = mkdtempSync(path.join(fixtureDirectory, '.features-write-engine-'));
  try {
    // Instrument only disposable fixture copies; the production source gets no
    // diagnostic API, global observer, Host capability, or runtime logging.
    let editor = readFileSync(path.join(directory, 'features.tsx'), 'utf8');
    const inject = (before: string, after: string) => {
      if (editor.split(before).length !== 2) throw new Error('History diagnostic anchor changed');
      editor = editor.replace(before, after);
    };
    inject('async function menu() {\n    if (disabled() || props.active === false || !taskID()) return;', 'async function menu() { featureHistoryPhase("menu-enter");\n    if (disabled() || props.active === false || !taskID()) { featureHistoryPhase("menu-rejected"); if (state.busy()) featureHistoryPhase("menu-rejected-busy"); if (state.committed()) featureHistoryPhase("menu-rejected-committed"); if (state.restoring()) featureHistoryPhase("menu-rejected-restoring"); if (state.uncertain()) featureHistoryPhase("menu-rejected-uncertain"); if (!state.interactive()) featureHistoryPhase("menu-rejected-inactive"); if (props.active === false) featureHistoryPhase("menu-rejected-prop-inactive"); if (!taskID()) featureHistoryPhase("menu-rejected-no-task"); return; }');
    inject("let choice = '';", 'featureHistoryPhase("menu-admitted"); let choice = "";');
    inject('const answer = await AlertDialog.show({ title: text(taskAuthority().name)', 'featureHistoryPhase("menu-dialog-requested"); const answer = await AlertDialog.show({ title: text(taskAuthority().name)');
    inject('] }); state.assertCurrent(); choice = text(answer.action);', '] }); featureHistoryPhase("menu-dialog-returned"); state.assertCurrent(); choice = text(answer.action);');
    inject('choice = text(answer.action);', 'choice = text(answer.action); featureHistoryPhase(["run", "history", "toggle", "delete", "cancel"].includes(choice) ? `menu-choice-${choice}` : "menu-choice-other");');
    inject("if (choice === 'history') {", 'featureHistoryPhase("menu-perform-settled"); if (choice === "history") { featureHistoryPhase("history-branch-entered");');
    inject('else { historyMounted.set(true); historyOpen.set(true); }', 'else { featureHistoryPhase("history-local-requested"); historyMounted.set(true); featureHistoryPhase(historyMounted() ? "history-mounted-true" : "history-mounted-false"); historyOpen.set(true); featureHistoryPhase(historyOpen() ? "history-open-true" : "history-open-false"); }');
    inject('<NativeSheet open={historyOpen()}', '<NativeSheet onLayout={event => featureHistoryLayout("sheet-host", event.bounds)} onOpen={() => featureHistoryPhase("history-sheet-opened")} open={historyOpen()}');
    inject('onOpenChange={event => historyOpen.set(event.open)} onClose={() => historyMounted.set(false)}', 'onOpenChange={event => { featureHistoryPhase(event.open ? "history-sheet-request-open" : "history-sheet-request-close"); historyOpen.set(event.open); }} onClose={() => { featureHistoryPhase("history-sheet-closed"); featureHistoryPhase(historyOpen() ? "history-closed-while-request-open" : "history-closed-after-request"); historyMounted.set(false); featureHistoryPhase("history-unmounted"); }}');
    const rewriteImports = (source: string, overrides: Record<string, string> = {}) => source.replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g, (_match, _quote: string, specifier: string) => `from ${JSON.stringify(overrides[specifier] ?? path.resolve(directory, specifier))}`);
    const historyPath = path.join(engineDirectory, 'features-history.tsx');
    let history = readFileSync(path.join(directory, 'features-history.tsx'), 'utf8');
    const historyAnchor = 'const history = createScheduledHistory(props.identity)';
    const activeAnchor = 'const visible = active(); untracked';
    const rootAnchor = 'return <View class="flex-1 gap-2"><View class="min-h-11 px-3 flex-row items-center">';
    const listAnchor = '<List testID="features-history"';
    if ([historyAnchor, activeAnchor, rootAnchor, listAnchor].some(anchor => history.split(anchor).length !== 2)) throw new Error('History content diagnostic anchor changed');
    history = history.replace(historyAnchor, 'featureHistoryPhase("history-content-created"); cleanup(() => featureHistoryPhase("history-content-disposed")); const history = createScheduledHistory(props.identity)')
      .replace(activeAnchor, 'const visible = active(); featureHistoryPhase(visible ? "history-content-active" : "history-content-inactive"); untracked')
      .replace(rootAnchor, 'return <View onLayout={event => featureHistoryLayout("root", event.bounds)} class="flex-1 gap-2"><View onLayout={event => featureHistoryLayout("header", event.bounds)} class="min-h-11 px-3 flex-row items-center">')
      .replace(listAnchor, '<List onLayout={event => featureHistoryLayout("list", event.bounds)} testID="features-history"');
    const trace = 'const featureHistoryPhase = (phase: string) => console.log("[features-history-phase]", phase);\nconst featureHistoryLayout = (part: string, bounds: { origin: { x: number; y: number }; size: { width: number; height: number } }) => console.log("[features-history-layout]", part, bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);\n';
    writeFileSync(historyPath, trace + rewriteImports(history));
    const editorPath = path.join(engineDirectory, 'features.tsx');
    writeFileSync(editorPath, trace + rewriteImports(editor, { './features-history': historyPath }));
    const entry = path.join(engineDirectory, 'App.tsx');
    writeFileSync(entry, rewriteImports(readFileSync(path.join(directory, 'features-write-ui-app.tsx'), 'utf8'), { './features': editorPath }));
    const config = JSON.parse(readFileSync(path.join(fixtureDirectory, 'nsh.json'), 'utf8'));
    config.theme = path.resolve(fixtureDirectory, config.theme);
    writeFileSync(path.join(engineDirectory, 'nsh.json'), JSON.stringify(config));
    const engineTest = path.join(engineDirectory, 'features-engine.test.tsx');
    writeFileSync(engineTest, [
      'import { expect, open, test } from "nsh/test";',
      'test("memory-only writes on the headless non-iOS surface", async () => {',
      `const app = await open(${JSON.stringify(entry)}, { platform: 'macos', storage: {}, network: {} });`,
      'try {', steps, '} finally { app.dispose(); }', '});',
    ].join('\n'));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', engineTest, '--web-host', path.join(directory, 'features-memory-host.js')], { cwd: fixtureDirectory, encoding: 'utf8', timeout: 90_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(engineDirectory, { recursive: true, force: true }); }
}, 100_000);
