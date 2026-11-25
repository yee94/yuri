import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileTreeChildren, useSingleToggleExpansion } from './FileTreeChildren';

let host: HTMLDivElement;
let root: Root;
let probe: { animate: boolean } = { animate: false };

const Tree = ({ expandedDirs, total }: { expandedDirs: string[]; total: number }) => {
  const animate = useSingleToggleExpansion(expandedDirs.length);
  probe = { animate };
  return (
    <ul>
      {Array.from({ length: total }, (_, index) => `d${index}`).map((dir) => (
        <li key={dir}>
          <FileTreeChildren expanded={expandedDirs.includes(dir)} animate={animate} className="kids">
            <li data-child={dir} />
          </FileTreeChildren>
        </li>
      ))}
    </ul>
  );
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (expandedDirs: string[], total = 40) => act(async () => root.render(<Tree expandedDirs={expandedDirs} total={total} />));

describe('FileTreeChildren', () => {
  test('a single toggle animates; expand-all style jumps do not', async () => {
    await render([]);
    await render(['d1']);
    expect(probe.animate).toBe(true);
    await render(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    expect(probe.animate).toBe(false);
  });

  test('restored expansion on first mount renders children without a collapsed start', async () => {
    const heights: string[] = [];
    const observer = new MutationObserver(() => {
      host.querySelectorAll<HTMLElement>('.kids').forEach((el) => heights.push(el.style.height));
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    await render(['d1', 'd2', 'd3', 'd4']);
    observer.disconnect();
    expect(host.querySelectorAll('.kids')).toHaveLength(4);
    expect(heights).not.toContain('0px');
  });

  test('collapsed directories mount no child list and a collapse unmounts it after the exit', async () => {
    await render(['d1']);
    expect(host.querySelectorAll('.kids')).toHaveLength(1);
    await render([]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(host.querySelectorAll('.kids')).toHaveLength(0);
  });

  test('toggling one directory leaves other directories’ child lists untouched', async () => {
    await render(['d1', 'd2']);
    const before = host.querySelector('[data-child="d1"]');
    await render(['d1', 'd2', 'd3']);
    expect(host.querySelector('[data-child="d1"]')).toBe(before);
  });
});
