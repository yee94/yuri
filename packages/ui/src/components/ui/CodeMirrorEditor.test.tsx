import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EditorView, keymap } from '@codemirror/view';
import { findNext, gotoLine, openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { CodeMirrorEditor } from './CodeMirrorEditor';

let host: HTMLDivElement;
let root: Root;
let view: EditorView;
const onChange = vi.fn();
const onViewReady = (ready: EditorView) => { view = ready; };

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

test('retains search without a go-to-line binding on mount and search reconfiguration', async () => {
  const render = async (enableSearch: boolean) => {
    await act(async () => root.render(<CodeMirrorEditor value={'first\nsecond'} onChange={onChange} onViewReady={onViewReady} enableSearch={enableSearch} />));
  };
  const assertSearch = () => {
    const bindings = view.state.facet(keymap).flat();
    expect(bindings.some((binding) => binding.run === gotoLine)).toBe(false);
    expect(bindings.some((binding) => binding.run === openSearchPanel)).toBe(true);
    expect(bindings.some((binding) => binding.run === findNext)).toBe(true);
  };
  await render(true);
  assertSearch();
  await render(false);
  expect(view.state.facet(keymap).flat().some((binding) => binding.run === openSearchPanel)).toBe(false);
  await render(true);
  assertSearch();
  await act(async () => { openSearchPanel(view); });
  expect(searchPanelOpen(view.state)).toBe(true);
});
