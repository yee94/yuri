import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(process.platform !== 'darwin')('real QuickJS/core + production terminal Host + NSH Network + offline Ghostty contract; synthetic backend, no shell or Vault', () => {
  const directory=path.dirname(fileURLToPath(import.meta.url));
  const temporary=mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR||process.env.TMPDIR||tmpdir(),'nsh-terminal-host-'));
  try {
    // Reuse the Host's exact dependencies, offline; do not change its manifest,
    // main/runtime modules or lockfile while that owner works in parallel.
    const manifest=readFileSync(path.join(directory,'desktop-host/Cargo.toml'),'utf8').replace('name = "yuri-nsh-desktop"','name = "yuri-terminal-validation"');
    writeFileSync(path.join(temporary,'Cargo.toml'),`${manifest}\n[lib]\npath="lib.rs"\n`);
    // The Host owner added native WS tests whose synthetic server is resolved
    // relative to CARGO_MANIFEST_DIR. Keep the same fixture in this temp crate.
    mkdirSync(path.join(temporary, 'fixtures'));
    writeFileSync(path.join(temporary, 'fixtures/terminal-ws.py'), readFileSync(path.join(directory, 'desktop-host/fixtures/terminal-ws.py')));
    writeFileSync(path.join(temporary,'lib.rs'),['policy','terminal_transport','terminal_host','terminal_viewport'].map(name=>`#[path=${JSON.stringify(path.join(directory,'desktop-host/src',`${name}.rs`))}]\npub mod ${name};`).join('\n'));
    writeFileSync(path.join(temporary,'nsh.json'),JSON.stringify({name:'Synthetic terminal core',id:'example.yuri.synthetic-terminal-core',version:'0.1.0',build:1,capabilities:{host:true}}));
    writeFileSync(path.join(temporary,'App.tsx'),`import ${JSON.stringify(path.join(directory,'desktop-terminal-transport.fixture.tsx'))};\n`);
    const build=spawnSync(process.env.NSH_BIN||'nsh',['build','App.tsx','--out',path.join(temporary,'bundle')],{cwd:temporary,encoding:'utf8',timeout:60_000});
    expect(build.error,build.stdout+build.stderr).toBeUndefined();expect(build.status,build.stdout+build.stderr).toBe(0);
    const result=spawnSync(process.env.CARGO||path.join(homedir(),'.cargo/bin/cargo'),['test','--offline','--manifest-path',path.join(temporary,'Cargo.toml'),'--target-dir',path.join(directory,'.nsh/desktop-target'),'--lib','--','--include-ignored'],{
      encoding:'utf8',timeout:120_000,env:{...process.env,NSH_TERMINAL_CORE_BUNDLE:path.join(temporary,'bundle/bundle.js')},
    });
    expect(result.error,result.stdout+result.stderr).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0);
    expect(result.stdout).toContain('production_core_host_registry_catalog_and_real_network_without_shell_or_vault ... ok');
    expect(result.stdout).toContain('uncertain_real_http_create_is_journaled_and_never_replayed_or_falsely_closed ... ok');
  } finally {rmSync(temporary,{recursive:true,force:true});}
},180_000);
