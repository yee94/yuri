import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { build } from 'vite';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession } from '../../components/ui/chromeCdpHarness';

test.skip('speech marker covers inline code backgrounds without moving text or changing unrelated code', async () => {
    const root = evidenceRoot();
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const chrome = await openChromeSession({ width: 402, height: 874 });
    try {
        const css = await compileProductionCssAsync(src);
        await build({
            configFile: false, root: join(src, '..'), publicDir: false, logLevel: 'error',
            build: {
                emptyOutDir: false, outDir: root, minify: false, reportCompressedSize: false,
                lib: { entry: join(src, 'lib/voice/speech-marker.ts'), formats: ['iife'], name: 'SpeechMarkerFixture', fileName: () => 'marker.js' },
            },
        });
        const themeVars = (name: string) => {
            const { colors } = JSON.parse(readFileSync(join(src, `lib/theme/themes/${name}.json`), 'utf8'));
            return Object.entries(colors.surface).map(([key, value]) => `--surface-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}:${value}`).join(';')
                + `;--primary:${colors.primary.base};--foreground:${colors.surface.foreground};--syntax-background:${colors.surface.muted}`;
        };
        const inlineStyles = readFileSync(join(src, 'components/chat/markstream/markstreamTheme.css'), 'utf8').replace(/^@import[^\n]*$/gm, '');
        const html = join(root, 'speech-marker-code.html');
        writeFileSync(html, `<!doctype html><html><meta charset="utf-8"><head><style>${css}${inlineStyles}
            :root{${themeVars('carbonfox-light')}}html.dark{${themeVars('cursor-dark')}}
            body{margin:0;padding:24px;background:var(--surface-background);color:var(--surface-foreground)}
            #reply{position:relative;font:18px/1.8 sans-serif}code{font-family:monospace;padding:4px 8px}
            </style></head><body><div class="yuri-markstream-host"><div id="reply"><div class="markstream-react markdown-renderer" data-speech-content>
            <ul><li>版本：<code class="inline-code">0.2.27-beta.1</code></li><li>提交：<code class="inline-code">b7385390d</code></li><li>标签：<code class="inline-code">mobile-beta/v0.2.27-beta.1</code></li></ul>
            <p>未朗读：<code class="inline-code">unchanged</code></p><pre><code>const keep = true;</code></pre>
            </div></div></div><script src="marker.js"></script><script>
            window.marker=SpeechMarkerFixture.createSpeechMarker(document.querySelector('#reply'));
            window.originalHTML=document.querySelector('#reply').innerHTML;
            window.showCode=(index)=>{const range=document.createRange();range.selectNodeContents(document.querySelectorAll('li')[index]);window.marker.update(range)};
            </script></body></html>`);
        const page = await openPageSession(chrome, { width: 402, height: 874, standalone: false });
        await page.navigateFile(html);
        for (const width of [402, 1100]) {
            await page.send('Emulation.setDeviceMetricsOverride', { width, height: 874, deviceScaleFactor: 1, mobile: false });
            for (const dark of [false, true]) {
                const before = await page.evaluate<{ height: number; codeBackground: string }>(`(()=>{
                    window.marker.stop();document.documentElement.classList.toggle('dark',${dark});
                    window.marker=SpeechMarkerFixture.createSpeechMarker(document.querySelector('#reply'));
                    return{height:document.querySelector('#reply').offsetHeight,codeBackground:getComputedStyle(document.querySelector('code')).backgroundColor};
                })()`);
                expect(before.codeBackground).not.toBe('rgba(0, 0, 0, 0)');
                for (let index = 0; index < 3; index++) {
                    const painted = await page.evaluate<{ background: string; active: boolean[]; height: number; strokes: number }>(`(()=>{
                        window.showCode(${index});return{background:getComputedStyle(document.querySelectorAll('li code')[${index}]).backgroundColor,
                        active:[...document.querySelectorAll('code')].map(c=>c.hasAttribute('data-speech-marker-inline-code')),
                        height:document.querySelector('#reply').offsetHeight,strokes:document.querySelectorAll('.yuri-speech-marker-stroke').length};
                    })()`);
                    expect(painted.background).toBe('rgba(0, 0, 0, 0)');
                    expect(painted.active).toEqual([index === 0, index === 1, index === 2, false, false]);
                    expect(painted.height).toBe(before.height);
                    expect(painted.strokes).toBeGreaterThan(0);
                }
                await page.evaluate('window.showCode(0)');
                const shot = await page.screenshotPng(join(root, `speech-code-${width}-${dark ? 'dark' : 'light'}.png`));
                const pixels = await page.evaluate<{ actual: number[]; expected: number[] }>(`new Promise((done)=>{
                    const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
                    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const rect=document.querySelector('code').getClientRects()[0];
                    const actual=[...ctx.getImageData(Math.floor(rect.left+2),Math.floor(rect.top+rect.height/2),1,1).data];
                    ctx.fillStyle=getComputedStyle(document.body).backgroundColor;ctx.fillRect(0,0,1,1);
                    ctx.fillStyle='color-mix(in srgb, '+getComputedStyle(document.documentElement).getPropertyValue('--primary')+' 22%, transparent)';ctx.fillRect(0,0,1,1);
                    done({actual,expected:[...ctx.getImageData(0,0,1,1).data]});};image.src=${JSON.stringify(`data:image/png;base64,${readFileSync(shot).toString('base64')}`)};
                })`);
                for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixels.actual[channel] - pixels.expected[channel])).toBeLessThanOrEqual(2);
                const restored = await page.evaluate<{ html: boolean; background: string }>(`(()=>{window.marker.stop();return{html:document.querySelector('#reply').innerHTML===window.originalHTML,background:getComputedStyle(document.querySelector('code')).backgroundColor}})()`);
                expect(restored.html).toBe(true);
                expect(restored.background).toBe(before.codeBackground);
            }
        }
    } finally {
        await chrome.close();
        if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
    }
}, 120_000);
