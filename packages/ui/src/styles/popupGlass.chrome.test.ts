import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { changedFilesPopoverClassName } from '../components/chat/changedFilesPopover';
import { dropdownMenuPopupClass } from '../components/ui/dropdown-menu.styles';
import { statusBarPopoverHeaderClassName, statusBarPopoverListClassName } from '../components/chat/statusBarPopover';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../components/ui/chromeCdpHarness';

test.skipIf(!resolveChrome())('popup glass shares theme fill but has lighter elevation and an opaque accessibility fallback', async () => {
  const root = evidenceRoot();
  const chrome = await openChromeSession({ width: 1000, height: 800 });
  try {
    const source = join(dirname(fileURLToPath(import.meta.url)), '..');
    const css = await compileProductionCssAsync(source);
    const themeVars = (name: string) => {
      const theme = JSON.parse(readFileSync(join(source, `lib/theme/themes/${name}.json`), 'utf8'));
      return Object.entries(theme.colors.surface).map(([key, value]) => `--surface-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}:${value}`).join(';');
    };
    const html = join(root, 'popup-glass.html');
    writeFileSync(html, `<!doctype html><html><head><style>${css}
      :root{${themeVars('carbonfox-light')}}html.dark{${themeVars('cursor-dark')}}
      body{margin:0;background:var(--surface-background);color:var(--surface-foreground)}
      .fixture{position:absolute;top:120px;left:80px;width:360px}
      </style></head><body>
      <main style="padding:40px;font-size:32px;line-height:2">Project workspace<br>Changes and recent conversations<br>Glass background</main>
      <section id="changes" class="fixture ${changedFilesPopoverClassName}">
      <header id="header" class="${statusBarPopoverHeaderClassName}">Changed files</header><div id="list" class="${statusBarPopoverListClassName}">
      ${Array.from({ length: 30 }, (_, i) => `<div class="px-3 py-2">src/example-${i}.tsx</div>`).join('')}</div></section>
      <section id="menu" class="${dropdownMenuPopupClass}" style="position:absolute;left:500px;top:120px;width:160px">Menu<div id="separator" class="yuri-popup-separator"></div>Action</section>
      <section id="picker" class="yuri-mobile-overlay-surface yuri-mobile-overlay-surface--translucent yuri-composer-autocomplete-surface" style="position:absolute;top:500px;left:80px;width:360px;height:100px">Picker</section>
      <script>window.inspectGlass=()=>{
        const style=id=>getComputedStyle(document.getElementById(id));
        const popup=style('changes'),picker=style('picker'),list=style('list');
        const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
        const alpha=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]};
        return {fill:popup.backgroundColor,alpha:alpha(popup.backgroundColor),blur:popup.backdropFilter,
          edge:popup.getPropertyValue('--yuri-popup-edge'),shadow:popup.boxShadow,pickerShadow:picker.boxShadow,
          sameFill:popup.backgroundColor===picker.backgroundColor,menuFill:style('menu').backgroundColor,
          foregroundAlpha:alpha(popup.getPropertyValue('--surface-foreground')),dividerAlpha:alpha(style('header').borderBottomColor),sameDivider:style('header').borderBottomColor===getComputedStyle(document.querySelector('#list > div')).borderBottomColor&&style('header').borderBottomColor===style('separator').backgroundColor,
          dividerWidth:style('separator').height,
          listFill:list.backgroundColor,listShadow:list.boxShadow,listScrolls:document.querySelector('#list').scrollHeight>document.querySelector('#list').clientHeight};
      };</script></body></html>`);
    const page = await openPageSession(chrome, { width: 1000, height: 800, standalone: false });
    await page.navigateFile(html);
    for (const dark of [false, true]) {
      await page.evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
      const normal = await page.evaluate<{ alpha: number; blur: string; edge: string; shadow: string; pickerShadow: string; sameFill: boolean; fill: string; menuFill: string; listFill: string; listShadow: string; listScrolls: boolean; foregroundAlpha: number; dividerAlpha: number; sameDivider: boolean; dividerWidth: string }>('window.inspectGlass()');
      expect(normal.alpha).toBeCloseTo(255 * 0.22, 0);
      expect(normal.blur).toContain('blur(20px)');
      expect(normal.edge).toContain(dark ? '16%' : '12%');
      expect(normal.sameFill).toBe(true);
      expect(normal.menuFill).toBe(normal.fill);
      expect(normal.shadow).toContain('20px');
      expect(normal.shadow).not.toContain('48px');
      expect(normal.pickerShadow).toContain('48px');
      expect(normal.listFill).toBe('rgba(0, 0, 0, 0)');
      expect(normal.listShadow).toBe('none');
      expect(normal.listScrolls).toBe(true);
      expect(normal.dividerAlpha).toBeCloseTo(normal.foregroundAlpha * (dark ? 0.08 : 0.06), 0);
      expect(normal.sameDivider).toBe(true);
      expect(normal.dividerWidth).toBe('0.5px');
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      const reduced = await page.evaluate<{ alpha: number; blur: string; shadow: string }>('window.inspectGlass()');
      expect(reduced.alpha).toBe(255);
      expect(reduced.blur).toBe('none');
      expect(reduced.shadow).toBe(normal.shadow);
    }
  } finally {
    await chrome.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
