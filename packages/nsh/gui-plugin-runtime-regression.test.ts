import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { compileGuiRuntime, runGuiFixture } from './gui-plugin-runtime-fixture.mjs';

// Existing owners' harnesses remain unchanged. Add GUI source dependencies only
// in this compilation wrapper, so their runtime contracts still run verbatim.
const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, terminal: string, asr: string, authorization: string, desktop: string, loopback: string;
const servers: ReturnType<typeof spawn>[] = [];
let terminalURL: string, desktopURL: string, errors = '';
async function start(relative: string): Promise<string> {
  const child = spawn('bun', [path.join(root, relative)], { stdio: ['ignore','pipe','pipe'] });
  servers.push(child); child.stderr!.on('data', data => { errors += data; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('loopback startup: ' + errors)),5000);
    child.stdout!.once('data', data => { clearTimeout(timer); resolve(JSON.parse(String(data)).configURL); });
    child.once('error',reject);
  });
}
beforeAll(async () => {
  temporary = await mkdtemp(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-owner-regression-'));
  terminal = await compileGuiRuntime(root,temporary,path.join(root,'terminal-runtime-harness.swift'),'terminal');
  asr = await compileGuiRuntime(root,temporary,path.join(root,'tests/settings-voice-recognition-transport.swift'),'asr');
  authorization = await compileGuiRuntime(root,temporary,path.join(root,'terminal-authorization-harness.swift'),'authorization');
  desktop = await compileGuiRuntime(root,temporary,path.join(root,'tests/remote-desktop-transport/Runner.swift'),'desktop');
  loopback = await compileGuiRuntime(root,temporary,path.join(root,'terminal-loopback-harness.swift'),'loopback');
  terminalURL = await start('terminal-loopback-fixture.mjs');
  desktopURL = await start('tests/remote-desktop-transport/fixture.mjs');
},180000);
afterAll(async()=>{
  for(const child of servers) if(child.exitCode===null) { const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed; }
  if(temporary) await rm(temporary,{recursive:true,force:true});
});
for(const mode of ['direct','relay']) {
  for(const scenario of ['routes','optional-missing','optional-empty','optional-failure','port','bad-port','redirect','oversize','invalid','stale','a-b-a','background','credential-change','cancel-http','retire-http','late-open','late-open-retire','cancel-send','incoming-limit','outgoing-limit',...(mode==='relay'?['mint-bearer']:[])]) {
    it(`existing terminal ${mode}/${scenario}`,async()=>{expect(await runGuiFixture(terminal,[scenario,mode],8000)).toBe(`PASS ${scenario} ${mode==='relay'}`);},12000);
  }
  for(const scenario of ['routes','cancel-open','generation-http','resource-admission','host-a-b-a','host-background',...(mode==='direct'?['authorization-roundtrip']:[]),'rename']) {
    it(`existing ASR ${mode}/${scenario}`,async()=>{expect(await runGuiFixture(asr,[scenario,mode],8000)).toBe(`PASS ${scenario} ${mode==='relay'}`);},12000);
  }
  for(const scenario of ['messages','cancel','close','oversize','outgoing','flood','unauthorized','disabled','unsupported','occupied','redirect','stale','cancel-upgrade','runtime-close','selected-host','multiplex','local-close']) {
    it(`existing desktop ${mode}/${scenario}`,async()=>{expect(await runGuiFixture(desktop,[desktopURL,mode,scenario],12000)).toBe(`PASS ${mode} ${scenario}`);expect(errors).toBe('');},15000);
  }
  for(const scenario of ['normal','auth-denied','ws-redirect',...(mode==='relay'?['mint-denied']:[]),'fallback','explicit-sse','runtime-stream','legacy-regression']) {
    it(`existing loopback ${mode}/${scenario}`,async()=>{
      const args=scenario==='normal'?[terminalURL,mode]:[terminalURL,mode,scenario,temporary];
      expect(await runGuiFixture(loopback,args,20000)).toBe(`PASS ${mode}${scenario==='normal'?'':' '+scenario}`);expect(errors).toBe('');
    },25000);
  }
}
for(const scenario of ['non-revocations','failed-remove','reauthorize','failed-reauthorize','remove','callback-failure','legacy']) {
  it(`existing authorization/${scenario}`,async()=>{expect(await runGuiFixture(authorization,[scenario],8000)).toBe(`PASS ${scenario}`);},12000);
}
for(const scenario of ['unpaired','upgrade-timeout','invalid-path','carrier-redirect','old-socket','bad-open','bad-close','bad-abort','bad-text','control-fragment','cancel-mint','switch-mint','bearer-url','expired-url','bad-mint','mint-denied']) {
  it(`existing desktop relay/${scenario}`,async()=>{expect(await runGuiFixture(desktop,[desktopURL,'relay',scenario],12000)).toBe(`PASS relay ${scenario}`);expect(errors).toBe('');},15000);
}
for(const scenario of ['fragments','invalid-utf8','fragment-overflow','queue-limit','closed-pending','duplicate-open']) {
  it(`existing native inbox/${scenario}`,async()=>{expect(await runGuiFixture(desktop,[desktopURL,'core',scenario],5000)).toBe(`PASS core ${scenario}`);},15000);
}
