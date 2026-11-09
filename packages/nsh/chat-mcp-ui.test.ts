import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { prepareInteractionEngineDriver } from './tests/chat-interaction-engine-driver';

const directory = path.dirname(fileURLToPath(import.meta.url));
test('production MCP sheet loads on presentation, toggles/refreshes, closes and defers Add until real close', () => {
  const temporary = mkdtempSync(path.join(directory, 'tests', '.mcp-ui-'));
  try {
    const entry = path.join(temporary, 'App.tsx'), host = path.join(temporary, 'host-entry.js');
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'MCP fixture', theme: path.join(directory, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request'] } }));
    writeFileSync(entry, `import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeChatMcp } from '../../chat-mcp';
import { language } from '../../i18n';
import { captureHostRequest } from '../../state';
import { prepareInteractionFixture } from '../chat-interaction-fixture-bootstrap';
function App(){
  language.set('en'); const open=signal(false), created=signal(false), draft=signal(''), count=signal(''), request=captureHostRequest();
  return <View class="flex-1"><Button testID="open-mcp" onPress={()=>open.set(true)}><Text>Open MCP</Text></Button>
  <Input testID="unrelated-draft" value={draft()} onChange={event=>draft.set(event.value)}/>
  <Button testID="audit-mcp" onPress={()=>{void request('/fixture/audit').then(value=>count.set(String(value)));}}><Text>Audit MCP</Text></Button><Text>{count()}</Text><Text>{created()?'Create after close':''}</Text>
  <NativeChatMcp directory="/workspace/mcp" open={open()} active onOpenChange={value=>open.set(value)} onCreate={()=>created.set(true)}/></View>;
}
mount(()=>{const boot=prepareInteractionFixture();return <If when={boot.ready()}><App/></If>;});`);
    writeFileSync(host, `import { interactionConnection, requireInteractionScope } from '../chat-interaction-fixture-scope.js';
export function createHost(){const saved=interactionConnection('mcp-fixture','synthetic-mcp-lease'); let reads=0,writes=0,connected=false;
return {call(name,input){if(name==='connection.list')return saved;if(name!=='runtime.request')throw Error('Unexpected native MCP call');requireInteractionScope(input,saved.runtimeScope);
if(input.path==='/fixture/audit')return {status:200,body:'reads:'+reads+' writes:'+writes};
const config='/api/config/mcp?directory=%2Fworkspace%2Fmcp',status='/api/mcp?location%5Bdirectory%5D=%2Fworkspace%2Fmcp';
if(input.method==='GET'&&input.path===config){reads++;return {status:200,body:[{name:'Fixture MCP'}]};}
if(input.method==='GET'&&input.path===status){reads++;return {status:200,body:{data:[{name:'Fixture MCP',status:{status:connected?'connected':'disabled'}}]}};}
if(input.method==='POST'&&input.path==='/api/experimental/mcp/Fixture%20MCP/connect?location%5Bdirectory%5D=%2Fworkspace%2Fmcp'){writes++;connected=true;return {status:200,body:{}};}
throw Error('Unexpected MCP path');}};}`);
    const driver = prepareInteractionEngineDriver(directory, entry, host, [
      'await app.waitFor("id:open-mcp");',
      'await app.press("id:audit-mcp"); await app.waitFor("text:reads:0 writes:0");',
      'await app.press("id:open-mcp"); await app.waitFor("id:chat-mcp-toggle-Fixture MCP");',
      'await app.waitUntil(()=>app.enabled("id:chat-mcp-toggle-Fixture MCP"));',
      'await app.press("id:chat-mcp-toggle-Fixture MCP");',
      'await app.waitUntil(()=>app.enabled("id:chat-mcp-toggle-Fixture MCP"));',
      'expect(app.shows("id:chat-mcp-unconfirmed")).toBe(false);',
      'await app.press("id:chat-mcp-refresh");',
      'await app.waitUntil(()=>app.enabled("id:chat-mcp-refresh"));',
      'await app.press("id:chat-mcp-close"); await app.waitFor("id:chat-mcp-sheet",{state:"gone"});',
      'await app.press("id:audit-mcp"); await app.waitFor("text:reads:6 writes:1");',
      'await app.type("id:unrelated-draft","Fifty unrelated inputs must not read the closed MCP sheet");',
      'await app.press("id:audit-mcp"); await app.waitFor("text:reads:6 writes:1");',
      'await app.press("id:open-mcp"); await app.waitUntil(()=>app.enabled("id:chat-mcp-create"));',
      'await app.press("id:chat-mcp-create"); await app.waitFor("text:Create after close");',
      'expect(app.shows("id:chat-mcp-sheet")).toBe(false);',
    ]);
    try {
      const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver.testFile, '--web-host', driver.bundleHost()], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally { driver.dispose(); }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);

test('production Chat MCP action opens the status sheet, not the Settings route', () => {
  const source = readFileSync(path.join(directory, 'application.tsx'), 'utf8');
  const action = source.match(/if \(action === 'mcp'\) ([^\n]+)/)?.[1];
  expect(action).toContain('mcpPanel.set(true)'); expect(action).not.toContain('nav.push');
  expect(source).toContain('<NativeChatMcp directory={props.target.directory}');
  expect(source).toContain("page: 'mcp', directory: props.target.directory, create: true");
});
