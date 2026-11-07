import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { revealSearchResult, searchNavigationScript } from './tests/projects-search-navigation';

/** Mounted-window model only: no claim about NSH engine geometry or scroll compensation. */
function virtualizedList(offset = 0) {
  let position = offset;
  const rows = Array.from({ length: 60 }, (_, i) => `id:row-${i}`);
  const visible = () => rows.slice(Math.floor(position / 60), Math.floor(position / 60) + 5);
  const app = {
    shows: (selector: string) => visible().includes(selector),
    texts: () => visible(),
    scroll: vi.fn(async (selector: string, distance: number) => {
      if (selector !== 'id:projects-search-results') throw new Error('Wrong scroll owner');
      position = Math.max(0, Math.min(rows.length * 60 - 300, position + distance));
    }),
    waitFor: vi.fn(async (selector: string) => { if (!visible().includes(selector)) throw new Error('Target outside mounted window'); }),
  };
  return app;
}

describe('search engine driver virtualized-row navigation (no engine)', () => {
  it('reproduces the unmounted-target failure and scrolls the actual List before waiting', async () => {
    const app = virtualizedList(540);
    await expect(app.waitFor('id:row-22')).rejects.toThrow('Target outside mounted window');
    app.waitFor.mockClear();
    await revealSearchResult(app, 'id:row-22');
    expect(app.shows('id:row-22')).toBe(true);
    expect(app.scroll).toHaveBeenCalled();
    expect(app.scroll.mock.calls.every(([selector]) => selector === 'id:projects-search-results')).toBe(true);
    expect(app.waitFor).toHaveBeenCalledExactlyOnceWith('id:row-22');
  });
  it('does not scroll a mounted target or assume that expansion preserves a particular viewport', async () => {
    const app = virtualizedList(1200);
    await revealSearchResult(app, 'id:row-21'); expect(app.scroll).not.toHaveBeenCalled();
    await revealSearchResult(app, 'id:row-2', -1); expect(app.shows('id:row-2')).toBe(true);
    expect(app.scroll.mock.calls[0][1]).toBe(-240);
  });
  it('searches backwards as well when relevance reordering puts the target behind the viewport', async () => {
    const app = virtualizedList(1800);
    await revealSearchResult(app, 'id:row-1');
    expect(app.shows('id:row-1')).toBe(true);
    expect(app.scroll.mock.calls.some(([, distance]) => distance > 0)).toBe(true);
    expect(app.scroll.mock.calls.some(([, distance]) => distance < 0)).toBe(true);
  });
  it('keeps missing rows as bounded failures with mounted diagnostics, not fallback success', async () => {
    const app = virtualizedList();
    await expect(revealSearchResult(app, 'id:missing')).rejects.toThrow('Search result not mounted after bounded bidirectional List scroll: id:missing');
    expect(app.scroll).toHaveBeenCalledTimes(36); expect(app.waitFor).not.toHaveBeenCalled();
  });
  it('propagates real List scroll errors instead of hiding a production scroll-owner failure', async () => {
    const app = virtualizedList(); app.scroll.mockRejectedValueOnce(new Error('Real scroll owner failed'));
    await expect(revealSearchResult(app, 'id:row-22')).rejects.toThrow('Real scroll owner failed');
    expect(app.scroll).toHaveBeenCalledTimes(1);
  });
  it('executes the exact generated stdin script without external imports or guessed driver APIs', async () => {
    const app = virtualizedList(540), context = vm.createContext({ app });
    vm.runInContext(searchNavigationScript(), context);
    await vm.runInContext('revealSearchResult(app, "id:row-22")', context);
    expect(app.shows('id:row-22')).toBe(true);
    expect(app.waitFor).toHaveBeenCalledExactlyOnceWith('id:row-22');
  });
  it('Bun-bundles the helper and executes its emitted stdin script with no NSH engine or URL globals', async () => {
    const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
    mkdirSync(parent, { recursive: true });
    const output = mkdtempSync(path.join(parent, 'nsh-search-navigation-'));
    try {
      const filename = path.join(output, 'navigation.cjs'), root = path.dirname(fileURLToPath(import.meta.url));
      const bundled = spawnSync('bun', ['build', 'tests/projects-search-navigation.ts', '--target=browser', '--format=cjs', '--outfile', filename], { cwd: root, encoding: 'utf8', timeout: 30_000 });
      expect(bundled.status, bundled.stdout + bundled.stderr).toBe(0);
      const app = virtualizedList(540), context = vm.createContext({ app, module: { exports: {} } });
      expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
      vm.runInContext(`(function(module) { ${readFileSync(filename, 'utf8')}\n})(module);`, context);
      vm.runInContext(vm.runInContext('module.exports.searchNavigationScript()', context), context);
      await vm.runInContext('revealSearchResult(app, "id:row-22")', context);
      expect(app.shows('id:row-22')).toBe(true);
      expect(app.waitFor).toHaveBeenCalledExactlyOnceWith('id:row-22');
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
});
