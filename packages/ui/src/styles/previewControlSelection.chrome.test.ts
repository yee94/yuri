import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { compileProductionCssAsync, evidenceRoot, openChromeSession, openPageSession } from '@/components/ui/chromeCdpHarness';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';

test.skip('global selection tokens align folder, header and preview controls in light and dark themes', async () => {
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const generator = new CSSVariableGenerator();
  const lightTheme = getDefaultTheme(false);
  const darkTheme = getDefaultTheme(true);
  const root = evidenceRoot();
  const chrome = await openChromeSession({ width: 800, height: 600 });
  try {
    const file = join(root, 'preview-selection.html');
    writeFileSync(file, `<!doctype html><html><head><style>${css}
      :root { ${generator.generate(lightTheme)} }
      html.dark { ${generator.generate(darkTheme)} }
      #expected { background: color-mix(in srgb, var(--surface-foreground) 7%, var(--background)); color: var(--surface-foreground); }
      html.dark #expected { background: ${darkTheme.colors.interactive.selection}; color: ${darkTheme.colors.interactive.selectionForeground}; }
      .selected { background: var(--interactive-selection); color: var(--interactive-selection-foreground); }
      #text-selection { background: ${lightTheme.colors.interactive.selection}; color: ${lightTheme.colors.interactive.selectionForeground}; }
      html.dark #text-selection { background: ${darkTheme.colors.interactive.selection}; color: ${darkTheme.colors.interactive.selectionForeground}; }
      </style></head><body>
      <header><button id="folder" class="bg-interactive-selection text-interactive-selection-foreground">Folder</button></header>
      <header><button id="header" class="selected">Files</button></header>
      <button id="preview" class="selected">Preview</button>
      <article id="text-selection">Editor text selection</article>
      <div id="expected">Expected neutral selection</div>
      </body></html>`);
    const page = await openPageSession(chrome, { width: 800, height: 600, standalone: false });
    await page.navigateFile(file);
    for (const dark of [false, true]) {
      const result = await page.evaluate<Record<string, { background: string; color: string }>>(`(() => {
        document.documentElement.classList.toggle('dark', ${dark});
        return Object.fromEntries(['folder', 'header', 'preview', 'text-selection', 'expected'].map(id => {
          const style = getComputedStyle(document.getElementById(id));
          return [id, { background: style.backgroundColor, color: style.color }];
        }));
      })()`);
      expect(result.preview).toEqual(result.header);
      expect(result.folder).toEqual(result.header);
      expect(result.preview).toEqual(result.expected);
      if (!dark) expect(result.preview).not.toEqual(result['text-selection']);
    }
  } finally {
    await chrome.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
