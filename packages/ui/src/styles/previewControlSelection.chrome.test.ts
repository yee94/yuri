import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { compileProductionCssAsync, evidenceRoot, openChromeSession, openPageSession, resolveChrome } from '@/components/ui/chromeCdpHarness';

test.skipIf(!resolveChrome())('preview toggles match header selection without changing content selection', async () => {
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const root = evidenceRoot();
  const chrome = await openChromeSession({ width: 800, height: 600 });
  try {
    const file = join(root, 'preview-selection.html');
    writeFileSync(file, `<!doctype html><html><head><style>${css}
      :root { --background: rgb(250, 248, 240); --surface-foreground: rgb(33, 33, 33);
        --interactive-selection: rgb(220, 230, 240); --interactive-selection-foreground: rgb(10, 20, 30); }
      html.dark { --background: rgb(26, 26, 26); --surface-foreground: rgb(222, 222, 222);
        --interactive-selection: rgb(50, 60, 70); --interactive-selection-foreground: rgb(240, 240, 240); }
      #expected { background: color-mix(in srgb, var(--surface-foreground) 7%, var(--background)); color: var(--surface-foreground); }
      .selected { background: var(--interactive-selection); color: var(--interactive-selection-foreground); }
      </style></head><body>
      <header class="yuri-preview-controls"><button id="header" class="selected">Files</button></header>
      <button id="preview" class="yuri-preview-controls selected">Preview</button>
      <article id="content" class="selected">Content selection</article>
      <div id="expected">Expected neutral selection</div>
      </body></html>`);
    const page = await openPageSession(chrome, { width: 800, height: 600, standalone: false });
    await page.navigateFile(file);
    for (const dark of [false, true]) {
      const result = await page.evaluate<Record<string, { background: string; color: string }>>(`(() => {
        document.documentElement.classList.toggle('dark', ${dark});
        return Object.fromEntries(['header', 'preview', 'content', 'expected'].map(id => {
          const style = getComputedStyle(document.getElementById(id));
          return [id, { background: style.backgroundColor, color: style.color }];
        }));
      })()`);
      expect(result.preview).toEqual(result.header);
      expect(result.preview).toEqual(dark ? result.content : result.expected);
      if (!dark) expect(result.preview).not.toEqual(result.content);
    }
  } finally {
    await chrome.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
