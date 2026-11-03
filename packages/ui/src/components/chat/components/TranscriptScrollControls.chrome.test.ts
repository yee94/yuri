import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { TranscriptScrollControls } from './TranscriptScrollControls';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../../ui/chromeCdpHarness';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

test.skipIf(!resolveChrome())('navigation follows compact pill geometry and uses the player green in light and dark', async () => {
    const root = evidenceRoot();
    const chrome = await openChromeSession({ width: 402, height: 874 });
    try {
        const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '../../..'));
        const controls = renderToStaticMarkup(React.createElement(TranscriptScrollControls, {
            active: true, scrollRef: { current: null }, showScrollToBottom: true, onScrollToBottom: () => {},
        }));
        const sprite = document.getElementById('yuri-icon-sprite-v2')?.outerHTML ?? '';
        const themeVars = (name: string) => {
            const { colors } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), `../../../lib/theme/themes/${name}.json`), 'utf8'));
            return Object.entries(colors.surface).map(([key, value]) => `--surface-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}:${value}`).join(';');
        };
        const html = join(root, 'transcript-controls.html');
        writeFileSync(html, `<!doctype html><html class="mobile-pointer device-mobile"><head><style>${css}
            :root{${themeVars('carbonfox-light')}}html.dark{${themeVars('cursor-dark')}}
            :root{--yuri-chat-column-max:48rem;--yuri-chat-foot-inset:160px;--yuri-safe-area-bottom-visual:0px;--primary-foreground:black}
            body{margin:0;background:var(--surface-background)}.fixture{position:relative;height:700px}.yuri-mobile-composer{padding-bottom:16px}
            </style></head><body>${sprite}<section class="fixture yuri-chat-composer-swap-scope" data-yuri-composer-swap-phase="rest">
            <div class="yuri-mobile-composer-foot yuri-mobile-composer-foot--overlay">${controls}
            <form class="yuri-mobile-composer"><div class="chat-input-column"><div class="yuri-mobile-composer-motion-viewport" style="height:144px">
            <div class="yuri-mobile-composer-compact-layer"></div></div></div></form></div></section>
            <script>const controls=document.querySelector('.yuri-transcript-scroll-controls');controls.style.setProperty('--yuri-transcript-compact-inset','60px');
            const active=controls.querySelector('button').cloneNode(true);active.classList.add('yuri-speech-follow-active');active.querySelector('use').setAttribute('href','#yuri-target');controls.querySelector('button').parentElement.append(active);</script></body></html>`);
        const page = await openPageSession(chrome, { width: 402, height: 874, standalone: false });
        await page.navigateFile(html);
        for (const width of [320, 402, 430, 1200]) {
            await page.send('Emulation.setDeviceMetricsOverride', { width, height: 874, deviceScaleFactor: 1, mobile: false });
            for (const dark of [false, true]) {
                for (const progress of (width === 1200 ? [0] : [0, 1])) {
                    const result = await page.evaluate<{ gap: number; rightInset: number; active: string; voice: string; count: number; sizes: { width: number; height: number; icon: number }[]; spacing: number; iconColor: string; halo: string; animation: string }>(`(()=>{
                        document.documentElement.classList.toggle('dark',${dark});
                        document.querySelectorAll('.yuri-transcript-scroll-controls button').forEach(b=>b.style.transition='none');
                        document.documentElement.classList.toggle('mobile-pointer',${width !== 1200});
                        document.documentElement.classList.toggle('desktop-runtime',${width === 1200});
                        const scope=document.querySelector('.fixture');
                        scope.dataset.yuriComposerSwapPhase='rest';
                        scope.dataset.yuriComposerSwapRest='${progress === 1 ? 'compact' : 'expanded'}';
                        document.querySelector('.yuri-mobile-composer-foot').style.setProperty('--yuri-mobile-composer-swap','${progress}');
                        const row=document.querySelector('.yuri-transcript-scroll-controls').getBoundingClientRect();
                        const pill=document.querySelector('.yuri-mobile-composer-compact-layer').getBoundingClientRect();
                        const button=document.querySelector('.yuri-speech-follow-active'),style=getComputedStyle(button);
                        const sample=document.createElement('span');sample.style.background='var(--voice-active-fill)';button.append(sample);
                        const voice=getComputedStyle(sample).backgroundColor;sample.remove();
                        const buttons=[...document.querySelectorAll('.yuri-transcript-scroll-controls button')];
                        return{gap:pill.top-row.bottom,rightInset:pill.right-button.getBoundingClientRect().right,active:style.backgroundColor,voice,count:buttons.length,
                            sizes:buttons.map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height,icon:b.querySelector('svg').getBoundingClientRect().width})),
                            iconColor:getComputedStyle(button.querySelector('svg')).color,halo:style.boxShadow,animation:style.animationName,
                            spacing:buttons[1].getBoundingClientRect().left-buttons[0].getBoundingClientRect().right};
                    })()`);
                    expect(result.count).toBe(2);
                    expect(result.active).toBe(result.voice);
                    expect(result.iconColor).toBe('rgb(255, 255, 255)');
                    expect(result.halo).not.toBe('none');
                    expect(result.animation).toBe('yuri-speech-follow-glow');
                    const diameter = 30 - 6 * progress;
                    for (const size of result.sizes) {
                        expect(size.width).toBeCloseTo(diameter, 1);
                        expect(size.height).toBeCloseTo(diameter, 1);
                        expect(size.icon).toBeCloseTo(diameter / 2, 1);
                    }
                    expect(result.spacing).toBeCloseTo(diameter / 5, 1);
                    if (progress === 1) {
                        expect(result.gap).toBeCloseTo(8, 0);
                        expect(result.rightInset).toBeCloseTo(10, 0);
                    }
                    if ((width === 402 && progress === 1) || width === 1200) {
                        await page.screenshotPng(join(root, `speech-follow-${width}-${dark ? 'dark' : 'light'}.png`));
                    }
                    if (width !== 1200) {
                        const transitions = await page.evaluate<{ display: string; boxes: number; animations: number }[]>(`(()=>{
                            const scope=document.querySelector('.fixture'),foot=document.querySelector('.yuri-mobile-composer-foot');
                            const controls=document.querySelector('.yuri-transcript-scroll-controls');
                            const results=[];
                            for(const phase of ['tracking','snapping','tracking','snapping']){
                                scope.dataset.yuriComposerSwapPhase=phase;
                                for(const progress of [0,0.01,0.5,0.99,1]){
                                    foot.style.setProperty('--yuri-mobile-composer-swap',String(progress));
                                    results.push({display:getComputedStyle(controls).display,
                                        boxes:[...controls.querySelectorAll('button')].reduce((count,b)=>count+b.getClientRects().length,0),
                                        animations:controls.getAnimations({subtree:true}).length});
                                }
                            }
                            scope.dataset.yuriComposerSwapPhase='rest';
                            foot.style.setProperty('--yuri-mobile-composer-swap','${progress}');
                            return results;
                        })()`);
                        for (const transition of transitions) {
                            expect(transition).toEqual({ display: 'none', boxes: 0, animations: 0 });
                        }
                        const restored = await page.evaluate<number[]>(`[...document.querySelectorAll('.yuri-transcript-scroll-controls button')].map(b=>b.getBoundingClientRect().width)`);
                        expect(restored).toHaveLength(2);
                        for (const size of restored) expect(size).toBeCloseTo(diameter, 1);
                    }
                }
            }
        }
        const nativeSizes = await page.evaluate<number[]>(`(()=>{
            document.documentElement.classList.add('yuri-native-ios-composer');
            document.querySelector('.fixture').dataset.yuriComposerSwapRest='compact';
            document.querySelector('.yuri-mobile-composer-foot').style.setProperty('--yuri-mobile-composer-swap','1');
            const sizes=[...document.querySelectorAll('.yuri-transcript-scroll-controls button')].map(b=>b.getBoundingClientRect().width);
            document.documentElement.classList.remove('yuri-native-ios-composer');return sizes;
        })()`);
        for (const size of nativeSizes) expect(size).toBeCloseTo(30, 1);
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        const reduced = await page.evaluate<{ animation: string; halo: string; color: string }>(`(()=>{
            const button=document.querySelector('.yuri-speech-follow-active'),style=getComputedStyle(button);
            return{animation:style.animationName,halo:style.boxShadow,color:getComputedStyle(button.querySelector('svg')).color};
        })()`);
        expect(reduced.animation).toBe('none');
        expect(reduced.halo).not.toBe('none');
        expect(reduced.color).toBe('rgb(255, 255, 255)');
    } finally {
        await chrome.close();
        if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
    }
}, 120_000);
