import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginWorkStatus } from '@/components/gui-plugins/GuiPluginWorkStatus';
import { GuiPluginHost, type PluginGuiBundle } from './host';
import { GuiPluginHostContext, GuiPluginsContext, getEmptySnapshot } from './react';
import type { GuiWorkStatusInput, GuiWorkStatusProps } from './work-status';

const hosts: GuiPluginHost[] = [];
let root: Root;
let container: HTMLDivElement;
let probe: { registrations: number; renders: number; cleanups: number; reads: number; props: GuiWorkStatusProps[]; ownOptions: unknown[] };
const input = (patch: Partial<GuiWorkStatusInput> = {}): GuiWorkStatusInput => ({
    sessionId: 'viewed', directory: '/work', project: { id: 'project', name: 'Work', directory: '/work' }, worktree: null,
    git: { state: 'ready', loading: false, branch: 'main', changedFiles: 2, additions: 4, deletions: 1 }, placement: 'inline', ...patch,
});
const bundle = (setup: string, revision = '1'): PluginGuiBundle => ({
    code: `const G=require('@opencode/plugin/gui'); const S=require('solid-js'); const p=globalThis.__workStatusProbe;
        module.exports=G.Plugin.define({setup(ctx){${setup}}});`, options: { marker: 'own-config' }, revision,
});
const widget = `
    const [shown,setShown]=S.createSignal(true);
    const [order,setOrder]=S.createSignal(0);
    function render(props) {
        p.renders++; p.props.push(props); p.ownOptions.push(G.usePlugin().options.marker);
        S.onCleanup(()=>p.cleanups++);
        const node=document.createElement('section');
        const field=document.createElement('input'); field.value='draft'; node.append(field);
        const text=document.createElement('span'); node.append(text);
        S.createEffect(()=>{p.reads++; text.textContent=props.git.branch+':'+props.git.changedFiles+':'+props.placement;});
        return node;
    }
    ctx.add(G.Registry.define('yuri.work-status'),()=>{p.registrations++; return shown()?{id:'widget',order:order(),render}:undefined;});
    ctx.add(G.Command,{id:'hide',title:'Hide',run(){setShown(false)}});
    ctx.add(G.Command,{id:'show',title:'Show',run(){setShown(true)}});
    ctx.add(G.Command,{id:'reorder',title:'Reorder',run(){setOrder(10)}});
`;
function host(transport = 'runtime') {
    const value = new GuiPluginHost({
        client: {} as OpenCodeClient, files: {} as FilesAPI, queryClient: new QueryClient(),
        storage: localStorage, transport, locale: 'en', mode: 'dark', narrow: false,
    });
    hosts.push(value);
    return value;
}
const show = async (host: GuiPluginHost | null, data: GuiWorkStatusInput, tick = 0) => {
    await act(async () => root.render(
        <GuiPluginsContext.Provider value={{ host, snapshot: { ...getEmptySnapshot(), sessionKey: String(tick) },
            inventory: [], error: null, loading: false, requested: true, requestLoad() {}, setEnabled() {}, refresh() {} }}>
            <GuiPluginHostContext.Provider value={host}><GuiPluginWorkStatus input={data} /></GuiPluginHostContext.Provider>
        </GuiPluginsContext.Provider>,
    ));
};
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    probe = { registrations: 0, renders: 0, cleanups: 0, reads: 0, props: [], ownOptions: [] };
    Reflect.set(globalThis, '__workStatusProbe', probe);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    hosts.splice(0).forEach((host) => host.dispose());
    container.remove(); localStorage.clear(); Reflect.deleteProperty(globalThis, '__workStatusProbe'); vi.restoreAllMocks();
});

it('orders by contribution order then inventory and registration, with collision-free identities', () => {
    const value = host();
    value.workStatus.setOrder(['first', 'last', 'first:extra']);
    value.install('last', bundle(`ctx.add(G.Registry.define('yuri.work-status'),{id:'widget',render:()=>null});`));
    value.install('first', bundle(`
        const R=G.Registry.define('yuri.work-status');
        ctx.add(R,{id:'z',render:()=>null}); ctx.add(R,{id:'a',render:()=>null});
        ctx.add(R,{id:'extra:widget',order:-1,render:()=>null});
    `));
    value.install('first:extra', bundle(`ctx.add(G.Registry.define('yuri.work-status'),{id:'widget',order:-1,render:()=>null});`));
    expect(value.workStatus.getSnapshot().map((row) => JSON.parse(row.key))).toEqual([
        ['first', 'extra:widget'], ['first:extra', 'widget'], ['first', 'z'], ['first', 'a'], ['last', 'widget'],
    ]);
    const snapshot = value.workStatus.getSnapshot();
    value.workStatus.setOrder(['first', 'last', 'first:extra']);
    expect(value.workStatus.getSnapshot()).toBe(snapshot);
});

it('keeps registration and mounting out of 50 unrelated updates, updating only changed Solid state', async () => {
    const value = host(); value.install('demo', bundle(widget));
    const data = input();
    const mount = vi.spyOn(value, 'mountWorkStatus');
    const subscribe = vi.spyOn(value.workStatus, 'subscribe');
    await show(value, data);
    const subscriptions = subscribe.mock.calls.length;
    const snapshot = value.workStatus.getSnapshot();
    const notify = vi.fn(); const stop = value.workStatus.subscribe(notify);
    const field = container.querySelector('input')!; field.value = 'keep my draft';
    for (let index = 0; index < 50; index++) {
        await act(async () => value.setSession({ id: `unrelated-${index}`, directory: '/other' }));
        await show(value, data, index);
    }
    expect(mount).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(subscriptions + 1);
    expect(value.workStatus.getSnapshot()).toBe(snapshot);
    expect(notify).not.toHaveBeenCalled();
    expect(probe).toMatchObject({ registrations: 1, renders: 1, reads: 1, cleanups: 0, ownOptions: ['own-config'] });
    expect(probe.props[0].session?.id).toBe('viewed');
    expect(probe.props[0].session?.directory).toBe('/work');
    expect(probe.props[0].session?.server.id).toBe('runtime');
    expect(probe.props[0].runtimeId).toBe('runtime');
    await show(value, input({ git: { ...data.git, branch: 'topic' }, placement: 'popover' }));
    expect(container.textContent).toBe('topic:2:popover');
    expect(probe.reads).toBe(2);
    expect(container.querySelector('input')).toBe(field);
    expect(field.value).toBe('keep my draft');
    for (let index = 0; index < 50; index++) await show(value, input({ git: { ...data.git, branch: 'topic' }, placement: 'popover' }));
    expect(probe.reads).toBe(2);
    expect(probe.renders).toBe(1);
    expect(notify).not.toHaveBeenCalled(); stop();
});

it('updates ordering without remounting and revokes withdrawn content immediately', async () => {
    const value = host(); value.install('demo', bundle(widget));
    value.install('other', bundle(`ctx.add(G.Registry.define('yuri.work-status'),{id:'other',order:5,render(){const node=document.createElement('b');node.textContent='other';return node;}});`));
    await show(value, input());
    const field = container.querySelector('input');
    expect(container.firstElementChild?.contains(field)).toBe(true);
    await act(async () => value.runCommand('demo.reorder'));
    expect(container.lastElementChild?.contains(field)).toBe(true);
    expect(probe.renders).toBe(1); expect(probe.cleanups).toBe(0);
    await act(async () => {
        value.runCommand('demo.hide');
        expect(probe.props[0].signal.aborted).toBe(true);
        expect(probe.props[0].active).toBe(false);
        expect(container.querySelector('input')).toBeNull();
    });
    expect(probe.cleanups).toBe(1);
    expect(container.textContent).toBe('other');
});

it('cancels old scopes on session, directory, revision, runtime and visibility changes', async () => {
    const value = host(); value.install('demo', bundle(widget));
    await show(value, input());
    const first = probe.props[0];
    await show(value, input({ sessionId: 'next' }));
    expect(first.signal.aborted).toBe(true);
    const second = probe.props[1];
    await show(value, input({ sessionId: 'next', directory: '/moved' }));
    expect(second.signal.aborted).toBe(true);
    await act(async () => value.install('demo', bundle(widget, '2')));
    expect(probe.props[2].signal.aborted).toBe(true);
    expect(probe.props[3].directory).toBe('/moved');
    const remote = host('other-runtime'); remote.install('demo', bundle(widget));
    await show(remote, input());
    expect(probe.props[3].signal.aborted).toBe(true);
    expect(probe.props[4].runtimeId).toBe('other-runtime');
    await show(null, input());
    expect(probe.props[4].signal.aborted).toBe(true);
    expect(probe.renders).toBe(5); expect(probe.cleanups).toBe(5);
});

it('remounts a withdrawn and re-added renderer even when React batches both catalog changes', async () => {
    const value = host(); value.install('demo', bundle(widget));
    await show(value, input());
    const field = container.querySelector('input');
    const first = value.workStatus.getSnapshot()[0];
    await act(async () => { value.runCommand('demo.hide'); value.runCommand('demo.show'); });
    const next = value.workStatus.getSnapshot()[0];
    expect(next.render).toBe(first.render);
    expect(next.generation).not.toBe(first.generation);
    expect(probe.props[0].signal.aborted).toBe(true);
    expect(container.querySelector('input')).not.toBeNull();
    expect(container.querySelector('input')).not.toBe(field);
    expect(probe.renders).toBe(2); expect(probe.cleanups).toBe(1);
});

it('keeps two visible instances independent and distinguishes unknown Git from a clean repository', () => {
    const value = host(); value.install('demo', bundle(widget));
    const entry = value.workStatus.getSnapshot()[0];
    const unknown = input({ sessionId: null, git: { state: 'unknown', loading: true, branch: null, changedFiles: null, additions: null, deletions: null } });
    const firstNode = document.createElement('div'); const secondNode = document.createElement('div');
    const first = value.mountWorkStatus(entry, firstNode, unknown);
    const second = value.mountWorkStatus(entry, secondNode, input({ sessionId: 'secondary', directory: '/secondary' }));
    expect(probe.props[0].session).toBeUndefined();
    expect(probe.props[0].git.changedFiles).toBeNull();
    first.update({ ...unknown, git: { state: 'ready', loading: false, branch: 'main', changedFiles: 0, additions: 0, deletions: 0 } });
    expect(probe.props[0].git.changedFiles).toBe(0);
    expect(probe.props[1].git.changedFiles).toBe(2);
    expect(Object.isFrozen(probe.props[0].git)).toBe(true);
    first.update(input());
    expect(probe.props[0].signal.aborted).toBe(true);
    expect(probe.props[1].signal.aborted).toBe(false);
    second.dispose(); second.dispose(); first.dispose();
    expect(probe.cleanups).toBe(2);
    expect(firstNode.children).toHaveLength(0); expect(secondNode.children).toHaveLength(0);
});

it('isolates malformed and throwing plugins, cleans active mounts, and retains diagnostics', async () => {
    const value = host(); value.install('healthy', bundle(widget));
    await show(value, input());
    value.install('invalid', bundle(`ctx.add(G.Registry.define('yuri.work-status'),{id:'bad',render:null});`));
    value.install('duplicate', bundle(`const R=G.Registry.define('yuri.work-status');ctx.add(R,{id:'same',render:()=>null});ctx.add(R,{id:'same',render:()=>null});`));
    await act(async () => value.install('broken', bundle(`ctx.add(G.Registry.define('yuri.work-status'),{id:'bad',render(){throw new Error('widget failed')}});`)));
    expect(value.workStatus.getSnapshot().map((entry) => entry.pluginId)).toEqual(['healthy']);
    expect(value.getSnapshot().plugins.find((plugin) => plugin.id === 'broken')).toMatchObject({ status: 'failed', error: 'widget failed' });
    expect(value.getSnapshot().plugins.filter((plugin) => plugin.status === 'failed')).toHaveLength(3);
    expect(probe.cleanups).toBe(0); expect(probe.renders).toBe(1);
    await act(async () => value.dispose());
    expect(probe.props[0].signal.aborted).toBe(true);
    expect(probe.cleanups).toBe(1); expect(container.children).toHaveLength(0);
});
