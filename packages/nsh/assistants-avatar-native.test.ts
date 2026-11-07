import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
it('measures reference native frame/model/SVG cost on the actual QuickJS engine, without a simulator', () => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(os.tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, 'nsh-avatar-budget-'));
  const entry = path.join(fixture, 'App.tsx');
  writeFileSync(path.join(fixture, 'nsh.json'), '{}');
  writeFileSync(entry, `
    import { mount, signal, Text, View } from 'nsh';
    import { createNativeAssistantFrames } from ${JSON.stringify(path.join(directory, 'assistants-avatar-frame'))};
    import { AVATAR_SHAPES, encodeAssistantAvatar, resolveAssistantAvatar } from ${JSON.stringify(path.join(directory, '../ui/src/lib/assistant-avatar/recipe'))};
    const report=signal('running'), sources=[], warm=[], results=[];let index=0;
    mount(()=><View><Text testID="avatar-budget-report">{report()}</Text></View>);
    function warmNext(){
      const start=performance.now(); const seed=encodeAssistantAvatar({...resolveAssistantAvatar('native'),shape:AVATAR_SHAPES[index%AVATAR_SHAPES.length]},'native-'+index);
      const source=createNativeAssistantFrames(seed); source.sample(0); sources.push(source);warm.push(performance.now()-start);
      if(++index<20)setTimeout(warmNext,0);else runCase(0,0,[]);
    }
    function runCase(group,frame,samples){
      const count=[1,5,20][group],start=performance.now();let bytes=0;
      for(let i=0;i<count;i++)bytes+=sources[i].sample(1/30).length;
      samples.push(performance.now()-start);
      if(frame<19){setTimeout(()=>runCase(group,frame+1,samples),0);return;}
      samples.sort((a,b)=>a-b);results.push({count,p50:samples[9],p95:samples[18],max:samples[19],uriCharacters:bytes});
      if(group<2)setTimeout(()=>runCase(group+1,0,[]),0);else report.set(JSON.stringify({results,coldMax:Math.max(...warm)}));
    }
    setTimeout(warmNext,0);
  `);
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', entry], { cwd: directory, input: 'await app.waitUntil(()=>app.texts().some(text=>text.startsWith("{\\"results\\"")),{timeout:150000});\nconsole.log("NATIVE_AVATAR_BUDGET "+app.texts().find(text=>text.startsWith("{\\"results\\"")));', encoding: 'utf8', timeout: 165_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const line = (result.stdout + result.stderr).split('\n').find(line => line.includes('NATIVE_AVATAR_BUDGET '));
  expect(line).toBeDefined();
  const metrics = JSON.parse(line!.slice(line!.indexOf('NATIVE_AVATAR_BUDGET ') + 'NATIVE_AVATAR_BUDGET '.length));
  console.info('Native avatar frame cost (ms, JS geometry + SVG only; excludes UIKit decode/paint):', JSON.stringify(metrics));
  expect(metrics.results.map((entry: { count: number }) => entry.count)).toEqual([1, 5, 20]);
}, 180_000);
