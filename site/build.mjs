import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dictionaries } from './src/i18n.mjs';
import { icons } from './src/icons.mjs';
import { snapshot } from './assets/downloads.js';
import { execFileSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'dist');
const assets = new Set([
  'assets/wallpaper/telegram-pattern.svg',
  'assets/wallpaper/LICENSE-telegram-pattern.txt',
]);
rmSync(output, { recursive: true, force: true });
const template = readFileSync(path.join(root, 'src/index.template.html'), 'utf8');

const statusIcons = '<span class="ti-signals"><svg viewBox="0 0 18 12" aria-hidden="true"><rect x="1" y="8" width="2.5" height="3.5" rx=".8"/><rect x="5" y="5.8" width="2.5" height="5.7" rx=".8"/><rect x="9" y="3.4" width="2.5" height="8.1" rx=".8"/><rect x="13" y="1" width="2.5" height="10.5" rx=".8"/></svg><svg viewBox="0 0 25 12" aria-hidden="true"><rect x=".75" y="1.25" width="20.5" height="9.5" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".55"/><rect x="2.4" y="2.9" width="15.8" height="6.2" rx="1.3"/><path d="M22.6 4.2v3.6a1.6 1.6 0 0 0 0-3.6Z" opacity=".5"/></svg></span>';

const pages = [
  { lang: 'zh', htmlLang: 'zh-CN', out: 'index.html', base: '', switchHref: 'en/' },
  { lang: 'en', htmlLang: 'en', out: 'en/index.html', base: '../', switchHref: '../' },
];

const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

for (const page of pages) {
  const dict = dictionaries[page.lang];
  const text = (key) => {
    if (!(key in dict)) throw new Error(`Missing ${page.lang} key: ${key}`);
    return dict[key];
  };
  const shot = (name) => {
    const localized = `en-${name}`;
    const file = page.lang === 'en' && existsSync(path.join(root, 'assets/shots', `${localized}.webp`)) ? localized : name;
    if (!existsSync(path.join(root, 'assets/shots', `${file}.webp`))) throw new Error(`Missing screenshot: ${file}`);
    return `${page.base}assets/shots/${file}.webp`;
  };
  const html = template
    .replaceAll('{{icons}}', `<svg class="icon-defs" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><defs>${Object.entries(icons).map(([name, body]) => `<symbol id="icon-${name}" viewBox="0 0 24 24">${body}</symbol>`).join('')}</defs></svg>`)
    .replace(/\{\{icon:(\w+)\}\}/g, (_, name) => {
      if (!icons[name]) throw new Error(`Missing icon ${name}`);
      return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
    })
    .replace(/\{\{download:(\w+)\}\}/g, (_, name) => {
      if (!snapshot.targets[name]) throw new Error(`Missing download ${name}`);
      return escapeHtml(snapshot.targets[name]);
    })
    .replaceAll('{{release}}', escapeHtml(snapshot.version + (snapshot.prerelease ? ' Beta' : '')))
    .replaceAll('{{device:start}}', `<div class="ti-phone"><span class="ti-btn ti-btn-action" aria-hidden="true"></span><span class="ti-btn ti-btn-vol-up" aria-hidden="true"></span><span class="ti-btn ti-btn-vol-down" aria-hidden="true"></span><span class="ti-btn ti-btn-power" aria-hidden="true"></span><div class="ti-bezel"><div class="ti-viewport"><div class="ti-statusbar" aria-hidden="true"><span class="ti-time">9:41</span><span class="ti-island"></span>${statusIcons}</div><div class="ti-screen">`)
    .replaceAll('{{device:end}}', '</div><span class="ti-home" aria-hidden="true"></span></div></div></div>')
    .replace(/\{\{words:([\w.-]+)\}\}/g, (_, key) => text(key).split('|')
      .map((word) => `<span class="word">${escapeHtml(word)}</span>`).join(''))
    .replace(/\{\{tags:([\w.-]+)\}\}/g, (_, key) => text(key).split('|')
      .map((tag) => `<li>${escapeHtml(tag)}</li>`).join(''))
    .replace(/\{\{img:([\w.-]+)\}\}/g, (_, name) => shot(name))
    .replace(/\{\{attr:([\w.-]+)\}\}/g, (_, key) => escapeHtml(text(key)))
    .replace(/\{\{t:([\w.-]+)\}\}/g, (_, key) => text(key))
    .replaceAll('{{lang}}', page.htmlLang)
    .replaceAll('{{base}}', page.base)
    .replaceAll('{{switchHref}}', page.switchHref)
    .replaceAll('{{docsHref}}', page.lang === 'zh' ? '/docs/' : '/en/docs/')
    .replace(/(src|href)="((?:\.\.\/)?assets\/[^"?]+)"/g, (_, attr, url) => {
      const file = path.join(root, url.replace(/^\.\.\//, ''));
      assets.add(url.replace(/^\.\.\//, ''));
      const version = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
      return `${attr}="${url}?v=${version}"`;
    });
  const leftover = html.match(/\{\{[^}]+\}\}/);
  if (leftover) throw new Error(`Unresolved placeholder ${leftover[0]} in ${page.out}`);
  const target = path.join(output, page.out);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html);
  console.log(`wrote ${page.out}`);
}
for (const asset of assets) {
  const target = path.join(output, asset);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, asset), target);
}
execFileSync('bun', [path.join(root, 'src/build-docs.mjs')], { stdio: 'inherit' });
