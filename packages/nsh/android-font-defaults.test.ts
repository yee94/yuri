import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { appearanceFromSettings } from './appearance-core';

const directory = path.dirname(fileURLToPath(import.meta.url));

test('Android default appearance uses its system mono renderer without a startup font warning, preserving explicit unsupported choices', async () => {
  const appearance = await appearanceFromSettings({ themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false }, async () => ({ themes: [] }));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(os.tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'android-font-defaults-'));
  try {
    const entry = path.join(root, 'Check.java');
    writeFileSync(entry, `package com.yee94.yuri.nsh;
      import java.util.*;
      public class Check {
        static void ready(NativeFontOwner.Projection value) {
          if (!value.status.equals("ready") || !value.unsupported.isEmpty())
            throw new AssertionError("startup font warning: " + value.status + " " + value.unsupported);
          if (!value.ui.equals("system-ui") || !value.mono.equals("monospace")
            || !value.assistantLight.equals("monospace") || !value.assistantDark.equals("monospace"))
            throw new AssertionError("default Android renderer must use the actual system mono family");
        }
        public static void main(String[] args) {
          Map<String,String> fonts = new LinkedHashMap<>(Map.of("ui",args[0],"mono",args[1],"assistantLight",args[2],"assistantDark",args[3]));
          NativeFontOwner owner = new NativeFontOwner(new NativeFontRegistry(), (host, revision, value) -> {});
          ready(owner.select("fixture", 1, fonts, false));
          ready(owner.select("fixture", 1, fonts, true));
          Map<String,String> explicit = new LinkedHashMap<>(fonts); explicit.put("mono", "JetBrains Mono");
          NativeFontOwner.Projection selected = owner.select("fixture", 1, explicit, false);
          if (!selected.status.equals("unsupported") || !selected.unsupported.equals(List.of("JetBrains Mono")))
            throw new AssertionError("explicit mono selection must retain truthful unsupported feedback");
          explicit = new LinkedHashMap<>(fonts); explicit.put("ui", "Inter");
          selected = owner.select("fixture", 1, explicit, false);
          if (!selected.unsupported.equals(List.of("Inter"))) throw new AssertionError("explicit UI selection was hidden");
          Map<String,String> inherited = new LinkedHashMap<>(fonts);
          inherited.put("assistantLight", "Inter"); inherited.put("assistantDark", "Fira Code");
          selected = owner.select("fixture", 1, inherited, false);
          if (!selected.status.equals("ready") || !selected.unsupported.isEmpty()
            || !selected.assistantLight.equals("system-ui") || !selected.assistantDark.equals("monospace"))
            throw new AssertionError("theme renderer must preserve its sans/mono role without requiring a custom face");
          inherited.put("assistantDark", "Unknown Theme Font");
          selected = owner.select("fixture", 1, inherited, false);
          if (!selected.unsupported.equals(List.of("Unknown Theme Font"))) throw new AssertionError("unknown renderer font was hidden");
          owner.invalidate(); ready(owner.select("other-host", 2, fonts, false));
          System.out.println("default-fonts-ready;explicit-font-warnings-preserved");
        }
      }`);
    const source = path.join(directory, 'android/src/com/yee94/yuri/nsh');
    const compile = spawnSync('javac', ['--release', '17', '-d', root, ...['NativeFontCatalog.java', 'NativeFontRegistry.java', 'NativeFontOwner.java'].map(name => path.join(source, name)), entry], { encoding: 'utf8', timeout: 30_000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const result = spawnSync('java', ['-cp', root, 'com.yee94.yuri.nsh.Check', appearance.fonts.ui, appearance.fonts.mono, appearance.fonts.assistantLight, appearance.fonts.assistantDark], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('default-fonts-ready;explicit-font-warnings-preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000);
