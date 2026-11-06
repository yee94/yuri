import { batch, createSignal, untrack, type JSX } from 'solid-js';
import type { MountedSession } from '@opencode/plugin/gui';

export const GUI_WORK_STATUS_REGISTRY = 'yuri.work-status';

type Project = Readonly<{ id?: string; name: string; directory: string }>;
type Worktree = Readonly<{ name: string; directory: string }>;
type GitSummary = Readonly<{
    state: 'unknown' | 'not-repository' | 'ready';
    loading: boolean;
    branch: string | null;
    changedFiles: number | null;
    additions: number | null;
    deletions: number | null;
}>;

export type GuiWorkStatusInput = Readonly<{
    sessionId: string | null;
    directory: string | null;
    project: Project | null;
    worktree: Worktree | null;
    git: GitSummary;
    placement: 'inline' | 'popover';
}>;

export interface GuiWorkStatusProps {
    readonly session: MountedSession | undefined;
    readonly directory: string | null;
    readonly runtimeId: string;
    readonly project: Project | null;
    readonly worktree: Worktree | null;
    readonly git: GitSummary;
    readonly placement: GuiWorkStatusInput['placement'];
    readonly active: boolean;
    readonly signal: AbortSignal;
}

export interface GuiWorkStatusContribution {
    readonly id: string;
    readonly order?: number;
    render(props: GuiWorkStatusProps): JSX.Element;
}

export type GuiWorkStatusEntry = Readonly<{
    key: string;
    pluginId: string;
    revision: string;
    generation: number;
    order: number;
    render: GuiWorkStatusContribution['render'];
}>;

export interface GuiWorkStatusMount {
    update(input: GuiWorkStatusInput): void;
    dispose(): void;
}

function sameFields<T extends object>(left: T | null, right: T | null): boolean {
    return left === right || Boolean(left && right && Object.keys(left).length === Object.keys(right).length
        && (Object.keys(left) as (keyof T)[]).every((key) => left[key] === right[key]));
}

const immutable = <T extends object>(value: T | null): Readonly<T> | null => value && Object.freeze({ ...value });

/** Per-mount state; data updates never publish the window's contribution catalog. */
export function createWorkStatusState(input: GuiWorkStatusInput, session: MountedSession | undefined, runtimeId: string) {
    const controller = new AbortController();
    const [active, setActive] = createSignal(true);
    const [project, setProject] = createSignal(immutable(input.project), { equals: sameFields });
    const [worktree, setWorktree] = createSignal(immutable(input.worktree), { equals: sameFields });
    const [git, setGit] = createSignal(Object.freeze({ ...input.git }), { equals: sameFields });
    const [placement, setPlacement] = createSignal(input.placement);
    const props: GuiWorkStatusProps = Object.freeze({
        session, directory: input.directory, runtimeId, signal: controller.signal,
        get active() { return active(); },
        get project() { return project(); },
        get worktree() { return worktree(); },
        get git() { return git(); },
        get placement() { return placement(); },
    });
    return {
        props,
        matches: (next: GuiWorkStatusInput) => next.sessionId === input.sessionId && next.directory === input.directory,
        update(next: GuiWorkStatusInput) {
            if (controller.signal.aborted) return;
            batch(() => {
                setProject(immutable(next.project));
                setWorktree(immutable(next.worktree));
                setGit(Object.freeze({ ...next.git }));
                setPlacement(next.placement);
            });
        },
        dispose() {
            if (controller.signal.aborted) return;
            setActive(false);
            controller.abort();
        },
    };
}

/** Registration-only subscription, separate from session/layout/stream snapshots. */
export class GuiWorkStatusCatalog {
    private plugins = new Map<string, readonly GuiWorkStatusEntry[]>();
    private order = new Map<string, number>();
    private snapshot: readonly GuiWorkStatusEntry[] = Object.freeze([]);
    private generation = 0;
    private listeners = new Set<() => void>();

    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    getSnapshot = (): readonly GuiWorkStatusEntry[] => this.snapshot;

    setOrder(ids: readonly string[]): void {
        if (ids.length === this.order.size && ids.every((id, index) => this.order.get(id) === index)) return;
        this.order = new Map(ids.map((id, index) => [id, index]));
        this.publish();
    }

    replace(pluginId: string, revision: string, inputs: readonly unknown[]): void {
        const previous = this.plugins.get(pluginId) ?? [];
        const ids = new Set<string>();
        const entries = inputs.map((value): GuiWorkStatusEntry => {
            if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
                || !value.id.trim() || value.id.length > 128 || ids.has(value.id)
                || !('render' in value) || typeof value.render !== 'function'
                || ('order' in value && value.order !== undefined && (typeof value.order !== 'number' || !Number.isFinite(value.order)))) {
                throw new Error('Invalid or duplicate yuri.work-status contribution');
            }
            ids.add(value.id);
            const key = JSON.stringify([pluginId, value.id]);
            const order = 'order' in value && typeof value.order === 'number' ? value.order : 0;
            const render = value.render as GuiWorkStatusContribution['render'];
            const old = previous.find((entry) => entry.key === key);
            const generation = old && old.revision === revision && old.render === render ? old.generation : ++this.generation;
            return old && old.revision === revision && old.render === render && old.order === order ? old
                : Object.freeze({ key, pluginId, revision, generation, order, render });
        });
        if (entries.length) this.plugins.set(pluginId, entries);
        else this.plugins.delete(pluginId);
        this.publish();
    }

    contains(entry: GuiWorkStatusEntry): boolean {
        return this.plugins.get(entry.pluginId)?.some((current) => current.key === entry.key
            && current.generation === entry.generation) ?? false;
    }

    remove(pluginId: string): void { if (this.plugins.delete(pluginId)) this.publish(); }
    dispose(): void { this.plugins.clear(); this.publish(); this.listeners.clear(); }

    private publish(): void {
        const rows = [...this.plugins.values()].flat().sort((a, b) => a.order - b.order
            || (this.order.get(a.pluginId) ?? Number.MAX_SAFE_INTEGER) - (this.order.get(b.pluginId) ?? Number.MAX_SAFE_INTEGER));
        if (rows.length === this.snapshot.length && rows.every((row, index) => row === this.snapshot[index])) return;
        this.snapshot = Object.freeze(rows);
        for (const listener of this.listeners) untrack(listener);
    }
}
