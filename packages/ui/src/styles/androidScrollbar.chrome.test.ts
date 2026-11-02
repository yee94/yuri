import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import {
  compileProductionCssAsync,
  evidenceRoot,
  openChromeSession,
  openPageSession,
  resolveChrome,
} from '@/components/ui/chromeCdpHarness';

test.skipIf(!resolveChrome())('Android overflow preserves content width and scrolling without changing other runtimes', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = await compileProductionCssAsync(join(here, '..'));
  const work = mkdtempSync(join(evidenceRoot(), 'android-scrollbar-'));
  const browser = await openChromeSession({ width: 390, height: 844, hideScrollbars: false });
  try {
    const file = join(work, 'index.html');
    writeFileSync(file, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${css}</style>
      </head><body><div id="root">
        <div id="scroller" style="width:350px;height:240px;overflow:auto">
          <div id="content" style="height:100px;width:100%">Settings</div>
        </div>
        <div id="chat" class="chat-scroll" data-scrollbar="chat" style="width:350px;height:240px;overflow:auto">
          <div style="height:1200px;width:700px">Chat</div>
        </div>
      </div></body></html>`);
    const page = await openPageSession(browser, { width: 390, height: 844, standalone: false });
    // Exercise classic scrollbar layout, not the emulator's always-overlay path.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    await page.navigateFile(file);

    const samples = await page.evaluate<Array<{
      runtime: string;
      before: number;
      after: number;
      chatWidth: number;
      chatHeight: number;
      scrollTop: number;
      scrollLeft: number;
      rootScrollbarWidth: string;
      webkitDisplay: string;
    }>>(`(() => {
      const root = document.documentElement;
      const scroller = document.getElementById('scroller');
      const content = document.getElementById('content');
      const chat = document.getElementById('chat');
      return [
        ['android', 'device-mobile mobile-pointer yuri-capacitor-app yuri-platform-android'],
        ['android-fine-pointer', 'device-mobile yuri-capacitor-app yuri-platform-android'],
        ['ios', 'device-mobile mobile-pointer yuri-capacitor-app yuri-platform-ios'],
        ['desktop', 'device-desktop desktop-runtime'],
      ].map(([runtime, classes]) => {
        root.className = classes;
        content.style.height = '100px';
        const before = content.getBoundingClientRect().width;
        content.style.height = '1200px';
        const after = content.getBoundingClientRect().width;
        chat.scrollTop = 120;
        chat.scrollLeft = 100;
        return {
          runtime, before, after,
          chatWidth: chat.clientWidth,
          chatHeight: chat.clientHeight,
          scrollTop: chat.scrollTop,
          scrollLeft: chat.scrollLeft,
          rootScrollbarWidth: getComputedStyle(root).scrollbarWidth,
          webkitDisplay: getComputedStyle(chat, '::-webkit-scrollbar').display,
        };
      });
    })()`);

    for (const sample of samples) {
      expect(sample.scrollTop, sample.runtime).toBe(120);
      expect(sample.scrollLeft, sample.runtime).toBe(100);
      if (sample.runtime.startsWith('android')) {
        expect(sample.after, sample.runtime).toBe(sample.before);
        expect(sample.chatWidth, sample.runtime).toBe(350);
        expect(sample.chatHeight, sample.runtime).toBe(240);
        expect(sample.rootScrollbarWidth, sample.runtime).toBe('none');
        expect(sample.webkitDisplay, sample.runtime).toBe('none');
      } else {
        // Positive control: this harness must expose occupying scrollbars.
        expect(sample.after, sample.runtime).toBeLessThan(sample.before);
        expect(sample.rootScrollbarWidth, sample.runtime).toBe('thin');
      }
    }
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
