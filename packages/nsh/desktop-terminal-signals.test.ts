import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real NSH signals: 50 typing receipts and 50 output/ACKs rebuild the root shortcut plan zero times', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-signals-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Terminal signal contract', id: 'example.terminal.signals', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['terminal.desktop.capabilities', 'terminal.capabilities', 'terminal.catalog.read', 'terminal.catalog.write', 'terminal.create', 'terminal.attach', 'terminal.detach', 'terminal.resize', 'terminal.input', 'terminal.probe', 'fixture.output'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-terminal-signals.fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'host.js'), `export function createHost(player) {
      let attachment, id = 0;
      return { async call(name, input) {
        if (name === 'terminal.desktop.capabilities') return { expectedHost: input.expectedHost, component: 'yuri.terminal.viewport', version: 1, native: true, inline: true, vt: true, inputReceipts: true, outputAcknowledgements: true, hostAppearance: true, selection: true, ime: true, bracketedPaste: true };
        if (name === 'terminal.capabilities') return { scope: 'native-opaque', wsVersion: 2, durableMetadata: true };
        if (name === 'terminal.catalog.read') return { schema: 1, hostID: input.expectedHost.hostID, directories: [] };
        if (name === 'terminal.create') return { sessionId: 'synthetic-session' };
        if (name === 'terminal.attach') { attachment = input; player.hostEvent('terminal.event', { ...input, type: 'connected' }); return true; }
        if (name === 'fixture.output') { if (!attachment) throw new Error('not attached'); id++; player.hostEvent('terminal.event', { ...attachment, type: 'data', id, data: id === 50 ? 'Local: http://localhost:3000/\\n' : 'OUTPUT\\r\\n' }); return true; }
        if (['terminal.catalog.write','terminal.input','terminal.resize','terminal.detach','terminal.probe'].includes(name)) return true;
        throw new Error('Unexpected fixture call: ' + name);
      } };
    }`);
    writeFileSync(path.join(temporary, 'signals.test.tsx'), `import { expect, open, test } from 'nsh/test';
      for (const platform of ['macos','windows'] as const) test('narrow signals '+platform,async()=>{
        const app=await open('./App.tsx',{platform,width:1000,height:700});
        const stats=async()=>{await app.press('id:terminal-signal-audit');return JSON.parse(app.texts().find(t=>t.startsWith('signal-audit:')).slice(13));};
        await app.wait(100);await app.press('id:terminal-signal-boot');await app.wait(150);
        const before=await stats();expect(before.ready).toBe(true);expect(before.focused).toBe(true);
        for(let i=0;i<50;i++)await app.type('id:terminal-signal-type','x');
        const typed=await stats();expect(typed.receipts-before.receipts).toBe(50);expect(typed.plans).toBe(before.plans);expect(typed.publications-before.publications).toBe(100);
        for(let i=0;i<50;i++)await app.press('id:terminal-signal-output');
        const output=await stats();expect(output.renders-before.renders).toBe(50);expect(output.plans).toBe(before.plans);expect(output.publications-typed.publications).toBe(50);expect(output.preview).toBe('http://localhost:3000/');
        await app.press('id:terminal-signal-preview');await app.wait(50);expect(app.texts()).toContain('signal-preview:'+JSON.stringify({authority:{hostID:'synthetic',lease:'synthetic-lease'},directory:'/synthetic',url:'http://localhost:3000/',mode:'preview'}));
        await app.press('id:terminal-signal-link');await app.wait(50);expect(app.texts()).toContain('signal-preview:'+JSON.stringify({authority:{hostID:'synthetic',lease:'synthetic-lease'},directory:'/synthetic',url:'http://localhost:3000/',mode:'preview'}));
        await app.press('id:terminal-signal-ime');const ime=await stats();expect(ime.composing).toBe(true);expect(ime.plans-before.plans).toBe(1);
        await app.press('id:terminal-signal-ime');expect((await stats()).plans-before.plans).toBe(2);
        await app.press('id:terminal-signal-hide');const hidden=await stats();expect(hidden.focused).toBe(false);expect(hidden.composing).toBe(false);expect(hidden.plans).toBeGreaterThan(ime.plans);
      });`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'signals.test.tsx', '--web-host', 'host.js'], { cwd: temporary, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    // The engine carrier uses the same production adapter. Guard the actual JSX
    // boundary too: its owner must not read the broad presentation signal.
    const source = readFileSync(path.join(root, 'desktop-terminal.tsx'), 'utf8');
    expect(source).toContain('changed: interaction.changed');
    expect(source).toContain('focused: interaction.focused, composing: interaction.composing');
    expect(source).toContain('active() && interaction.ready()');
    expect(source).not.toContain('state().focused'); expect(source).not.toContain('state().composing');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 150_000);
