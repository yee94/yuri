import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { compileGuiRuntime, runGuiFixture } from './gui-plugin-runtime-fixture.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, runner: string, isolation: string, url: string, server: ReturnType<typeof spawn>, errors = '';
beforeAll(async () => {
  temporary = await mkdtemp(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-runtime-'));
  runner = await compileGuiRuntime(root, temporary, path.join(root, 'gui-plugin-runtime-harness.swift'));
  isolation = await compileGuiRuntime(root, temporary, path.join(root, 'gui-plugin-runtime-isolation.swift'),'isolation');
  server = spawn('bun', [path.join(root,'gui-plugin-runtime-server.mjs')],{stdio:['ignore','pipe','pipe']});
  server.stderr!.on('data',value=>{errors+=value;});
  url = await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('GUI loopback startup: '+errors)),5000);
    server.stdout!.once('data',value=>{clearTimeout(timer);resolve(String(value).trim());});
    server.once('error',reject);
  });
},120000);
afterAll(async()=>{
  if(server?.exitCode===null) { const closed=new Promise(resolve=>server.once('close',resolve));server.kill();await closed; }
  if(temporary) await rm(temporary,{recursive:true,force:true});
});
it.each(['direct','relay'])('production %s reader pulls 33.0625 MiB and preserves lifecycle/fidelity',async mode=>{
  const result=await runGuiFixture(runner,[url,mode],90000);
  console.info(result);
  expect(result).toContain(`GUI runtime ${mode} large/fidelity/redirect/cancel/retire passed`);
  expect(errors).toBe('');
},100000);
it('paused GUI lanes cannot block shared HTTP/global/chat/terminal/pong beyond the old heartbeat deadline',async()=>{
  const result=await runGuiFixture(isolation,[url],70000);
  expect(result).toContain('GUI isolation passed >47s');
  expect(errors).toBe('');
},75000);
