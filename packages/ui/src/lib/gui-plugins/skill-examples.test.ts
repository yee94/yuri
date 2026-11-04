import { afterEach, expect, it, vi } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginHost } from './host';

const hosts: GuiPluginHost[] = [];
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); document.body.replaceChildren(); localStorage.clear(); });
async function example(name: string) {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../web/server/lib/gui-customization/skill/references', `${name}.md`);
    const markdown = await fs.readFile(file, 'utf8');
    const source = markdown.match(/```ts\n([\s\S]*?)\n```/)?.[1];
    if (!source) throw new Error('Missing reference example');
    return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
function fixture() {
    const openPage = vi.fn(() => true);
    const files = { readFile: vi.fn(async (path) => ({ path, content: '{"summary":"ok"}' })), listDirectory: vi.fn(async () => ({ directory: '/work', entries: [] })), search: vi.fn(async () => []) } as unknown as FilesAPI;
    const host = new GuiPluginHost({ client: {} as OpenCodeClient, files, queryClient: new QueryClient(), storage: localStorage, transport: 'examples', locale: 'en', mode: 'dark', narrow: false, openPage });
    hosts.push(host);
    return { host, openPage, files };
}
it('runs the shipped global-page reference through the real plugin context and titlebar', async () => {
    const { host, openPage } = fixture();
    host.install('studio', { code: await example('global-pages'), options: { message: 'Own config reached the page' }, revision: '1' });
    expect(host.getSnapshot().plugins[0].status).toBe('active');
    const page = host.getSnapshot().pages[0];
    host.runTitlebarItem(host.getSnapshot().titlebarItems[0].key);
    expect(openPage).toHaveBeenCalledWith(page.key);
    const node = document.createElement('div'); document.body.append(node);
    host.mountPage(page.key, node);
    expect(node.textContent).toBe('Own config reached the page');
    host.uninstall('studio'); expect(node.childElementCount).toBe(0);
});
it('runs the shipped custom-suffix parser as a real file Panel and keeps network links out', async () => {
    const { host, files } = fixture();
    host.setSession({ id: 's1', directory: '/work' });
    host.install('report', { code: await example('file-previews'), options: {}, revision: '1' });
    expect(host.getSnapshot().plugins[0].status).toBe('active');
    expect(host.openLink({ href: 'https://example.invalid/file.report.json' })).toBe(false);
    expect(host.openLink({ href: 'file.report.json' })).toBe(true);
    const node = document.createElement('div'); document.body.append(node);
    const panel = host.getSnapshot().panels[0];
    expect(panel.file).toBe('/work/file.report.json');
    host.mountPanel(panel.key, node);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(files.readFile).toHaveBeenCalled();
    expect(node.querySelector('pre')?.textContent).toContain('"summary": "ok"');
    host.uninstall('report'); expect(node.childElementCount).toBe(0);
});
