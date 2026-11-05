import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { changedFilesPopoverClassName } from '../components/chat/changedFilesPopover';
import { dropdownMenuPopupClass } from '../components/ui/dropdown-menu.styles';
import { statusBarPopoverHeaderClassName, statusBarPopoverListClassName } from '../components/chat/statusBarPopover';
import { bundleUiModule, compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession } from '../components/ui/chromeCdpHarness';

test.skip('popup glass has a readable theme fill, real menu blur and an opaque accessibility fallback', async () => {
  const root = evidenceRoot();
  const chrome = await openChromeSession({ width: 1000, height: 800 });
  try {
    const source = join(dirname(fileURLToPath(import.meta.url)), '..');
    const css = await compileProductionCssAsync(source);
    const menuEntry = join(root, 'popup-menu.ts');
    const menuBundle = join(root, 'popup-menu.js');
    writeFileSync(menuEntry, `import React from ${JSON.stringify(join(source, '../node_modules/react/index.js'))};
      import { createRoot } from ${JSON.stringify(join(source, '../node_modules/react-dom/client.js'))};
      import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from ${JSON.stringify(join(source, 'components/ui/dropdown-menu.tsx'))};
      createRoot(document.getElementById('menu-host')).render(React.createElement(DropdownMenu,{defaultOpen:true},
        React.createElement(DropdownMenuTrigger,{style:{position:'absolute',left:500,top:80,width:160,height:36}},'Open menu'),
        React.createElement(DropdownMenuContent,{id:'menu',align:'start',style:{width:160,paddingBottom:70}},
          React.createElement(DropdownMenuItem,{},'Menu'),React.createElement('div',{id:'separator',className:'yuri-popup-separator'}))));`);
    await bundleUiModule(menuEntry, menuBundle, source);
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
      <div style="position:absolute;left:500px;top:120px;width:160px;height:160px;background:repeating-linear-gradient(90deg,var(--surface-foreground) 0 4px,var(--surface-background) 4px 8px)"></div>
      <div id="menu-host"></div><script src="${menuBundle}"></script>
      <section id="picker" class="yuri-mobile-overlay-surface yuri-mobile-overlay-surface--translucent yuri-composer-autocomplete-surface" style="position:absolute;top:500px;left:80px;width:360px;height:100px">Picker</section>
      <section class="${dropdownMenuPopupClass}" style="position:absolute;left:500px;top:300px;width:360px">
        <button id="model-header" class="model-picker-section-header sticky top-0 [background:linear-gradient(var(--surface-elevated),var(--surface-elevated)),linear-gradient(var(--surface-background),var(--surface-background))]">Favorites</button>
        <input id="model-search" class="model-picker-search bg-[var(--surface-elevated)] hover:[&:not(:focus)]:bg-[var(--surface-subtle)] ring-1 ring-inset ring-border/60 focus:ring-2 focus:ring-[var(--interactive-focus-ring)]" placeholder="Search models">
      </section>
      <button id="sheet-model-header" class="model-picker-section-header [background:linear-gradient(var(--surface-elevated),var(--surface-elevated)),linear-gradient(var(--surface-background),var(--surface-background))]" style="position:absolute;left:500px;top:500px">Favorites</button>
      <input id="sheet-model-search" class="model-picker-search bg-[var(--surface-elevated)]" style="position:absolute;left:500px;top:550px">
      <section id="session-context" class="${dropdownMenuPopupClass} yuri-session-context-menu" style="position:absolute;left:80px;top:640px">Session menu</section>
      <section id="session-submenu" class="${dropdownMenuPopupClass} yuri-session-context-menu" style="position:absolute;left:300px;top:640px">Move to folder</section>
      <script>window.inspectGlass=()=>{
        const style=id=>getComputedStyle(document.getElementById(id));
        const popup=style('changes'),picker=style('picker'),list=style('list');
        const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
        const alpha=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]};
        return {fill:popup.backgroundColor,alpha:alpha(popup.backgroundColor),blur:popup.backdropFilter,
          edge:popup.getPropertyValue('--yuri-popup-edge'),shadow:popup.boxShadow,pickerShadow:picker.boxShadow,
          sameFill:popup.backgroundColor===picker.backgroundColor,menuFill:style('menu').backgroundColor,
          foreground:popup.color,foregroundAlpha:alpha(popup.getPropertyValue('--surface-foreground')),dividerAlpha:alpha(style('header').borderBottomColor),sameDivider:style('header').borderBottomColor===getComputedStyle(document.querySelector('#list > div')).borderBottomColor&&style('header').borderBottomColor===style('separator').backgroundColor,
          dividerWidth:style('separator').height,
          listFill:list.backgroundColor,listShadow:list.boxShadow,listScrolls:document.querySelector('#list').scrollHeight>document.querySelector('#list').clientHeight};
      };</script></body></html>`);
    const page = await openPageSession(chrome, { width: 1000, height: 800, standalone: false });
    await page.navigateFile(html);
    await page.evaluate(`new Promise(resolve=>{const check=()=>document.querySelector('#menu[data-open]')&&!document.querySelector('#menu[data-starting-style]')?resolve():requestAnimationFrame(check);check()})`);
    for (const dark of [false, true]) {
      await page.evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
      const normal = await page.evaluate<{ alpha: number; blur: string; edge: string; shadow: string; pickerShadow: string; sameFill: boolean; fill: string; menuFill: string; listFill: string; listShadow: string; listScrolls: boolean; foreground: string; foregroundAlpha: number; dividerAlpha: number; sameDivider: boolean; dividerWidth: string }>('window.inspectGlass()');
      expect(normal.alpha).toBe(Math.round(255 * 0.5));
      expect(normal.blur).toContain('blur(20px)');
      expect(normal.edge).toContain(dark ? '16%' : '12%');
      expect(normal.sameFill).toBe(false);
      expect(normal.menuFill).toBe(normal.fill);
      expect(normal.shadow).toContain('20px');
      expect(normal.shadow).not.toContain('48px');
      expect(normal.pickerShadow).toContain('48px');
      expect(normal.listFill).toBe('rgba(0, 0, 0, 0)');
      expect(normal.listShadow).toBe('none');
      expect(normal.listScrolls).toBe(true);
      if (dark) {
        expect(normal.foreground).toBe('rgb(222, 222, 222)');
        expect(normal.foregroundAlpha).toBe(255);
      }
      expect(normal.dividerAlpha).toBeCloseTo(normal.foregroundAlpha * (dark ? 0.08 : 0.06), 0);
      expect(normal.sameDivider).toBe(true);
      expect(normal.dividerWidth).toBe('0.5px');
      const inspectSessionMenus = () => page.evaluate<Array<{ alpha: number; blur: string }>>(`['session-context','session-submenu'].map(id=>{
        const style=getComputedStyle(document.getElementById(id));
        const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
        ctx.fillStyle=style.backgroundColor;ctx.fillRect(0,0,1,1);
        return {alpha:ctx.getImageData(0,0,1,1).data[3],blur:style.backdropFilter};
      })`);
      expect((await inspectSessionMenus()).map(menu => menu.alpha)).toEqual([128, 128]);
      await page.evaluate(`document.documentElement.setAttribute('data-yuri-vibrancy','')`);
      expect((await inspectSessionMenus()).map(menu => menu.alpha)).toEqual([128, 128]);
      await page.evaluate(`document.documentElement.classList.add('desktop-runtime')`);
      const vibrantSessionMenus = await inspectSessionMenus();
      expect(vibrantSessionMenus.map(menu => menu.alpha)).toEqual([235, 235]);
      expect(vibrantSessionMenus.every(menu => menu.blur.includes('blur(20px)'))).toBe(true);
      expect((await page.evaluate<{ menuFill: string }>('window.inspectGlass()')).menuFill).toBe(normal.menuFill);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      expect(await inspectSessionMenus()).toEqual([{ alpha: 255, blur: 'none' }, { alpha: 255, blur: 'none' }]);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
      await page.evaluate(`document.documentElement.removeAttribute('data-yuri-vibrancy')`);
      expect((await inspectSessionMenus()).map(menu => menu.alpha)).toEqual([128, 128]);
      await page.evaluate(`document.documentElement.classList.remove('desktop-runtime')`);
      const menuClip = await page.evaluate<{ x: number; y: number; width: number; height: number; scale: number }>(`(()=>{const r=document.getElementById('menu').getBoundingClientRect();return {x:r.x+20,y:r.bottom-50,width:100,height:30,scale:1}})()`);
      const screenshotContrast = async () => {
        const capture = await page.send('Page.captureScreenshot', { format: 'png', clip: menuClip });
        return page.evaluate<number>(`new Promise(resolve=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const d=ctx.getImageData(0,15,img.width,1).data;const values=Array.from({length:img.width},(_,i)=>d[i*4]);resolve(Math.max(...values)-Math.min(...values))};img.src='data:image/png;base64,${capture.data}'})`);
      };
      const blurredContrast = await screenshotContrast();
      await page.evaluate(`document.getElementById('menu').style.backdropFilter='none'`);
      const sharpContrast = await screenshotContrast();
      await page.evaluate(`document.getElementById('menu').style.removeProperty('backdrop-filter')`);
      expect(sharpContrast).toBeGreaterThan(20);
      expect(blurredContrast).toBeLessThan(sharpContrast * 0.3);
      const inspectModelPicker = () => page.evaluate<{ headerFill: string; headerImage: string; searchFill: string; searchRing: string; sheetHeaderImage: string; sheetSearchFill: string }>(`(()=>{
        const style=id=>getComputedStyle(document.getElementById(id));
        return {headerFill:style('model-header').backgroundColor,headerImage:style('model-header').backgroundImage,
          searchFill:style('model-search').backgroundColor,searchRing:style('model-search').boxShadow,
          sheetHeaderImage:style('sheet-model-header').backgroundImage,sheetSearchFill:style('sheet-model-search').backgroundColor};
      })()`);
      const modelPicker = await inspectModelPicker();
      expect(modelPicker.headerFill).toBe('rgba(0, 0, 0, 0)');
      expect(modelPicker.headerImage).toBe('none');
      expect(modelPicker.searchFill).toBe('rgba(0, 0, 0, 0)');
      expect(modelPicker.sheetHeaderImage).toContain('linear-gradient');
      expect(modelPicker.sheetSearchFill).not.toBe('rgba(0, 0, 0, 0)');
      const searchCenter = await page.evaluate<{ x: number; y: number }>(`(()=>{const r=document.getElementById('model-search').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...searchCenter });
      expect((await inspectModelPicker()).searchFill).toBe('rgba(0, 0, 0, 0)');
      await page.evaluate(`document.getElementById('model-search').focus()`);
      const focusedModelPicker = await inspectModelPicker();
      expect(focusedModelPicker.searchFill).toBe('rgba(0, 0, 0, 0)');
      expect(focusedModelPicker.searchRing).not.toBe('none');
      await page.evaluate(`document.getElementById('model-search').blur()`);
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
