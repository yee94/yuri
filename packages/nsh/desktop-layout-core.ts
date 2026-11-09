export interface DesktopLayout {
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  panelExpanded: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  terminalExpanded: boolean;
}

export const desktopLayoutDefaults: Readonly<DesktopLayout> = Object.freeze({
  sidebarOpen: true, sidebarWidth: 260,
  panelOpen: false, panelWidth: 600, panelExpanded: false,
  terminalOpen: false, terminalHeight: 280, terminalExpanded: false,
});

export function desktopDimension(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Persist geometry only, never a connection, credential, draft or remote resource. */
export function desktopLayoutFrom(value: unknown): DesktopLayout {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const flag = (key: keyof DesktopLayout) => typeof row[key] === 'boolean' ? row[key] as boolean : desktopLayoutDefaults[key] as boolean;
  return {
    sidebarOpen: flag('sidebarOpen'), sidebarWidth: desktopDimension(row.sidebarWidth, 260, 260, 500),
    panelOpen: flag('panelOpen'), panelWidth: desktopDimension(row.panelWidth, 600, 300, 1400), panelExpanded: flag('panelExpanded'),
    terminalOpen: flag('terminalOpen'), terminalHeight: desktopDimension(row.terminalHeight, 280, 120, 1200), terminalExpanded: flag('terminalExpanded'),
  };
}

export function desktopWorkspaceGeometry(width: number, layout: DesktopLayout) {
  const available = Math.max(0, Number.isFinite(width) ? width : 0);
  const sidebar = layout.sidebarOpen ? layout.sidebarWidth : 0;
  const workspace = Math.max(0, available - sidebar);
  const panel = layout.panelOpen ? Math.min(layout.panelWidth, workspace) : 0;
  const panelOnly = layout.panelOpen && (layout.panelExpanded || workspace - panel < 350);
  return { sidebar, workspace, panel: panelOnly ? workspace : panel, contentVisible: !panelOnly };
}

export interface DesktopLayoutStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
}

/** User actions beat a late restore; failed writes keep the current usable layout. */
export function createDesktopLayoutPersistence(storage: DesktopLayoutStorage, changed: (layout: DesktopLayout) => void, failed: (error: unknown) => void) {
  const key = 'desktop.layout.v1';
  let current = desktopLayoutFrom(null), revision = 0, alive = true, writes = Promise.resolve();
  let pending = 0, restoring = 0, fault = false;
  const canClose = () => alive && pending === 0 && restoring === 0 && !fault;
  const restore = async () => {
    const ticket = revision;
    restoring++;
    try {
      const serialized = await storage.getItem(key);
      const next = desktopLayoutFrom(serialized ? JSON.parse(serialized) : null);
      if (alive && ticket === revision) { fault = false; current = next; changed(current); }
    } catch (error) { if (alive && ticket === revision) { fault = true; failed(error); } }
    finally { restoring--; }
  };
  const persist = () => {
    const snapshot = JSON.stringify(current);
    pending++;
    writes = writes.then(async () => { if (alive) { await storage.setItem(key, snapshot); fault = false; } })
      .catch(error => { if (alive) { fault = true; failed(error); } }).finally(() => { pending--; });
    return writes;
  };
  return {
    restore,
    set(patch: Partial<DesktopLayout>) {
      revision++;
      current = desktopLayoutFrom({ ...current, ...patch });
      changed(current);
      return persist();
    },
    retry: persist,
    async flush() { await writes; return canClose(); },
    canClose,
    dispose() { alive = false; revision++; },
  };
}
