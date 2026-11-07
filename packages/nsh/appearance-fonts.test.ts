import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(directory, 'assets/fonts/jetbrains-mono');
const manifest = JSON.parse(readFileSync(path.join(assets, 'manifest.json'), 'utf8')) as { family: string; version: string; sha256: Record<string, string> };

test('bundled original JetBrains Mono fonts and original OFL match the pinned source checksums', () => {
  expect(manifest.family).toBe('JetBrains Mono'); expect(manifest.version).toBe('2.304');
  for (const [name, hash] of Object.entries(manifest.sha256)) {
    const bytes = readFileSync(path.join(assets, name));
    expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(hash);
    if (name.endsWith('.ttf')) expect([...bytes.subarray(0, 4)]).toEqual([0, 1, 0, 0]);
  }
  expect(readFileSync(path.join(assets, 'OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
});

test('CoreText registers all six original faces as JetBrains Mono 2.304, not a system-font substitute (no simulator)', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-appearance-fonts-'));
  try {
    const names = Object.keys(manifest.sha256).filter(name => name.endsWith('.ttf'));
    expect(names).toHaveLength(6);
    const paths = names.map(name => path.join(assets, name));
    const source = `import Foundation
import CoreText
let files = ${JSON.stringify(paths)}
var found = Set<String>()
for file in files {
    let url = URL(fileURLWithPath: file)
    var error: Unmanaged<CFError>?
    precondition(CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error))
    let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as! [CTFontDescriptor]
    for descriptor in descriptors {
        let font = CTFontCreateWithFontDescriptor(descriptor, 15.75, nil)
        precondition(CTFontCopyFamilyName(font) as String == "JetBrains Mono")
        precondition((CTFontCopyName(font, kCTFontVersionNameKey) as String?)?.contains("2.304") == true)
        found.insert(CTFontCopyPostScriptName(font) as String)
    }
}
precondition(found.count == 6)
precondition(found.contains("JetBrainsMono-Regular") && found.contains("JetBrainsMono-BoldItalic"))
let actual = CTFontCreateWithName("JetBrainsMono-Regular" as CFString, 15.75, nil)
precondition(CTFontCopyFamilyName(actual) as String == "JetBrains Mono")
print("jetbrains-mono-original-faces-ok")
`;
    const file = path.join(temporary, 'main.swift'); writeFileSync(file, source);
    const result = spawnSync('xcrun', ['swift', file], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('jetbrains-mono-original-faces-ok');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
