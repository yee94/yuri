import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import ts from 'typescript';

const directory = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, fixture: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'nsh-queue-presentation-'));
  fixture = path.join(temporary, 'App.tsx');
  writeFileSync(fixture, `import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeChatQueue } from ${JSON.stringify(path.join(directory, 'chat-queue.tsx'))};
import { NativeGoalRow } from ${JSON.stringify(path.join(directory, 'chat-goal.tsx'))};
const inbox = signal([
  { id: 'one', delivery: 'queue', payload: { text: 'First preview line\\nSecond line stays in the full payload' } },
  { id: 'two', delivery: 'queue', payload: { text: 'Second queued input', files: [{name:'attachment.txt'}] } },
  { id: 'three', delivery: 'steer', payload: { text: 'Steering input' } },
]);
const height = signal(0), hasGoal = signal(true), details = signal(false), error = signal(''), draft = signal('');
const goal = { id:'goal', objective:'A very long first Goal line which must truncate before actions\\nFull second Goal line', status:'active', rounds:1, maxRounds:50 };
const owner = {state:()=>({goal, busy:false, readError:null, actionError:null}),controller:{scope:{sessionID:'fixture'},toggle:async()=> 'acknowledged'}};
const chat = {inbox,queueError:error,active:()=>true,queueBusy:()=>'',sending:()=>false,editInbox:async()=>true,steerInbox:async()=>true,cancelInbox:async()=>true};
mount(() => <View class="flex-1 p-3">
  <Button testID="clear-queue" onPress={()=>inbox.set([])}><Text>Clear queue fixture</Text></Button>
  <Button testID="hide-goal" onPress={()=>hasGoal.set(false)}><Text>Hide Goal fixture</Text></Button>
  <Button testID="queue-error" onPress={()=>error.set('Synthetic queue failure')}><Text>Queue error fixture</Text></Button>
  <Button testID="edit-draft" onPress={()=>draft.set(draft()+'x')}><Text>Edit unrelated draft</Text></Button>
  <Text testID="fixture-draft">{draft()}</Text>
  <Text>height:{height()}</Text>
  <View onLayout={event=>height.set(event.bounds.size.height)}><NativeChatQueue chat={chat} trailingVisible={hasGoal()} trailing={<NativeGoalRow owner={owner} enabled active open={details()} onOpenChange={details.set} />} /></View>
</View>);
`);
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture], { cwd: directory, encoding: 'utf8', timeout: 30_000, input: steps.join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('the production composer keeps Changes/Tasks above the shared queue/Goal shell, then the single glass editor', () => {
  const source = ts.createSourceFile('application.tsx', readFileSync(path.join(directory, 'application.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements: ts.JsxSelfClosingElement[] = [];
  let editor = -1;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && ['NativeComposerChanges', 'NativeComposerTasks', 'NativeChatQueue'].includes(node.tagName.getText(source))) elements.push(node);
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'View' && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'testID' && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'composer-glass')) editor = node.pos;
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(elements.map(node => node.tagName.getText(source))).toEqual(['NativeComposerChanges', 'NativeComposerTasks', 'NativeChatQueue']);
  expect(elements[0].pos).toBeLessThan(elements[1].pos);
  expect(elements[1].pos).toBeLessThan(elements[2].pos);
  expect(elements[2].pos).toBeLessThan(editor);
  const trailing = elements[2].attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'trailing');
  expect(trailing?.getText(source)).toContain('<NativeGoalRow');
});

test.each([320, 375, 402])('native queue/Goal share one compact shell at %ipt, with a one-line preview and no extra queue heading', width => {
  run([
    `await app.setViewport(${width},874);`,
    'await app.waitFor("id:chat-queue-shell");',
    'expect(app.count("id:chat-queue-shell >> id:chat-goal-row")).toBe(1);',
    'expect(app.count("id:chat-queue-shell >> id:chat-queue")).toBe(1);',
    'expect(app.count("id:chat-queue-goal-divider")).toBe(1);',
    'await app.setColorScheme("dark");',
    'expect(app.count("id:chat-queue-shell >> id:chat-goal-row")).toBe(1);',
    'expect(app.enabled("id:queue-edit-one")).toBe(true);',
    'await app.setColorScheme("light");',
    'expect(app.count("id:chat-queue-shell >> id:chat-goal-row")).toBe(1);',
    'expect(app.texts()).toContain("First preview line...");',
    'expect(app.texts()).not.toContain("Second line stays in the full payload");',
    'expect(app.shows("id:queue-steering-three")).toBe(true);',
    'expect(app.shows("id:queue-steer-three")).toBe(false);',
    'expect(app.enabled("id:queue-edit-one")).toBe(true);',
    'expect(app.enabled("id:queue-remove-three")).toBe(true);',
    'await app.waitUntil(()=>Number(app.texts().find(text=>text.startsWith("height:")).slice(7))>0);',
    'expect(Number(app.texts().find(text=>text.startsWith("height:")).slice(7)) <= 160).toBe(true);',
    'for(let i=0;i<50;i++) await app.press("id:edit-draft");',
    'expect(app.count("id:chat-queue-shell")).toBe(1);',
    'expect(app.count("id:chat-goal-panel")).toBe(0);',
    'await app.press("id:clear-queue");',
    'expect(app.count("id:chat-queue")).toBe(0);',
    'expect(app.count("id:chat-queue-goal-divider")).toBe(0);',
    'expect(app.count("id:chat-queue-shell >> id:chat-goal-row")).toBe(1);',
    'await app.press("id:hide-goal");',
    'expect(app.count("id:chat-queue-shell")).toBe(0);',
    'await app.press("id:queue-error");',
    'expect(app.shows("text:Synthetic queue failure")).toBe(true);',
    'expect(app.count("id:chat-queue-shell")).toBe(1);',
  ]);
}, 40_000);
