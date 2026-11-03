import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { dict } from '@/lib/i18n/messages/en';
import { compileProductionCssAsync, evidenceRoot, openChromeSession, openPageSession, resolveChrome } from '@/components/ui/chromeCdpHarness';

test.skipIf(!resolveChrome())('Schedule hint travels left and back without changing existing height; add stays circular', async () => {
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
  const work = mkdtempSync(join(evidenceRoot(), 'schedule-hint-'));
  const browser = await openChromeSession({ width: 390, height: 844 });
  try {
    const file = join(work, 'index.html');
    writeFileSync(file, `<!doctype html><html class="dark device-mobile mobile-pointer"><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
      <style>:root { --surface-background: #181818; --surface-muted: #262626; --surface-foreground: #dedede; --dpt-n: 1; }
      body { margin: 0; } #root { min-height: 100vh; } #fixture { padding: 16px var(--yuri-mobile-page-inline-inset); }</style>
      </head><body><div id="root"><div class="yuri-mobile-floating-shell"><section id="fixture" role="tabpanel">
      <div class="yuri-mobile-scheduled-workspace">
        <header id="header" class="yuri-mobile-collapsing-header flex shrink-0 items-start gap-4">
          <div class="yuri-mobile-collapsing-header-inner">
            <div class="yuri-mobile-collapsing-header-title-block min-w-0 flex-1"><h1 class="yuri-mobile-root-page-title">Schedule</h1></div>
            <div class="yuri-mobile-collapsing-header-trailing flex min-h-10 shrink-0 items-center gap-3.5">
              <span id="anchor" class="yuri-mobile-schedule-assistant-anchor"><button id="hint" class="yuri-mobile-schedule-assistant" data-visiting="true">
                <span id="face" class="yuri-mobile-schedule-assistant-face"><span style="display:block;width:40px;height:40px;border-radius:50%"></span></span>
                <span id="copy" class="yuri-mobile-schedule-assistant-label">${dict['sessions.scheduledTasks.assistant.offer']}</span>
              </button></span>
            </div>
          </div>
        </header>
        <div class="yuri-mobile-collapsing-header-spacer"></div>
        <div id="content" class="yuri-mobile-floating-surface yuri-mobile-segmented-track" style="margin-top:20px">
          <span style="flex:1">All &nbsp; Active &nbsp; Paused</span>
          <button id="add" class="yuri-mobile-floating-action yuri-mobile-inverse-action yuri-mobile-segmented-action">+</button>
        </div>
      </div></section></div></div></body></html>`);
    const page = await openPageSession(browser, { width: 390, height: 844, standalone: false });
    await page.navigateFile(file);
    const samples = await page.evaluate<Array<{
      width: number; theme: string; time: number; top: number; height: number; headerHeight: number;
      anchorHeight: number; faceX: number; labelOpacity: number; addWidth: number; addHeight: number;
      radius: number; corner: string; scrollWidth: number; viewportWidth: number; textHit: boolean;
      textLines: number; textFits: boolean; fontSize: number;
    }>>(`(() => {
      const fixture = document.getElementById('fixture');
      const hint = document.getElementById('hint');
      const animations = hint.getAnimations({ subtree: true });
      animations.forEach(animation => animation.pause());
      const samples = [];
      for (const theme of ['dark', 'light']) {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        for (const width of [350, 390, 430]) {
          fixture.style.width = width + 'px';
          for (const time of [0, 1200, 3000, 6000, 7000]) {
            animations.forEach(animation => { animation.currentTime = time; });
            const bounds = document.getElementById('content').getBoundingClientRect();
            const add = document.getElementById('add');
            const addBounds = add.getBoundingClientRect();
            const addStyle = getComputedStyle(add);
            const copy = document.getElementById('copy');
            const copyBounds = copy.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(copy);
            const textRects = [...range.getClientRects()].filter(rect => rect.width > 0);
            const textTarget = document.elementFromPoint(copyBounds.left + 5, copyBounds.top + copyBounds.height / 2);
            samples.push({ width, theme, time, top: bounds.top, height: bounds.height,
              headerHeight: document.getElementById('header').getBoundingClientRect().height,
              anchorHeight: document.getElementById('anchor').getBoundingClientRect().height,
              faceX: document.getElementById('face').getBoundingClientRect().left,
              labelOpacity: Number(getComputedStyle(document.getElementById('copy')).opacity),
              addWidth: addBounds.width, addHeight: addBounds.height,
              radius: parseFloat(addStyle.borderTopLeftRadius), corner: addStyle.cornerShape,
              scrollWidth: fixture.scrollWidth, viewportWidth: fixture.clientWidth,
              textHit: textTarget === hint || hint.contains(textTarget),
              textLines: new Set(textRects.map(rect => Math.round(rect.top))).size,
              textFits: textRects.every(rect => rect.left >= copyBounds.left && rect.right <= copyBounds.right && rect.top >= copyBounds.top && rect.bottom <= copyBounds.bottom),
              fontSize: parseFloat(getComputedStyle(copy).fontSize),
            });
          }
        }
      }
      return samples;
    })()`);
    for (const theme of ['dark', 'light']) {
      for (const width of [350, 390, 430]) {
        const group = samples.filter(sample => sample.width === width && sample.theme === theme);
        const [closed, opening, holding, lastHold, returned] = group;
        for (const sample of group) {
          expect(sample.top).toBe(closed.top);
          expect(sample.height).toBe(closed.height);
          expect(sample.headerHeight).toBe(closed.headerHeight);
          expect(sample.anchorHeight).toBe(0);
          expect(sample.scrollWidth).toBe(sample.viewportWidth);
          expect(sample.addWidth).toBe(sample.addHeight);
          expect(sample.radius).toBeGreaterThanOrEqual(sample.addWidth / 2);
          expect(['round', 'superellipse(1)']).toContain(sample.corner);
          expect(sample.textLines).toBe(2);
          expect(sample.textFits).toBe(true);
          expect(sample.fontSize).toBe(12);
        }
        expect(opening.faceX).toBeLessThan(closed.faceX - 100);
        expect(holding.faceX).toBeCloseTo(opening.faceX, 2);
        expect(lastHold.faceX).toBeCloseTo(opening.faceX, 2);
        expect(returned.faceX).toBeCloseTo(closed.faceX, 2);
        expect(closed.labelOpacity).toBe(0);
        expect(opening.labelOpacity).toBeGreaterThan(0.99);
        expect(holding.labelOpacity).toBe(1);
        expect(lastHold.labelOpacity).toBe(1);
        expect(returned.labelOpacity).toBe(0);
        expect(closed.textHit).toBe(false);
        expect(holding.textHit).toBe(true);
        expect(returned.textHit).toBe(false);
      }
    }
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
