import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MobileModelPickerPanel } from './MobileModelPickerPanel';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  getCurrentIntlLocale: () => 'en-US',
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ui/ModelLogo', () => ({ ModelLogo: () => { rowRenders.count += 1; return null; } }));
vi.mock('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('@/components/ui/matchingPress', () => ({
  markMatchingPress: () => undefined,
  consumeMatchingPress: () => true,
}));
vi.mock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef<HTMLDivElement, { children: React.ReactNode; onScroll?: React.UIEventHandler }>(
    ({ children, onScroll }, ref) => <div ref={ref} data-testid="scroller" onScroll={onScroll}>{children}</div>,
  ),
}));
vi.mock('@/components/ui/MobileResizableSheet', () => ({
  MobileResizableSheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const claudeOpus = { id: 'claude-opus', name: 'Claude Opus' };
const claudeSonnet = { id: 'vps-us/claude/claude-sonnet-5-5', name: 'Claude Sonnet 5.5' };
const providers: ModelPickerProvider[] = [
  { id: 'anthropic', name: 'Anthropic', models: [claudeOpus, { id: 'haiku', name: 'Claude Haiku' }] },
  { id: 'magpie-remote-magpie%2Fvps-us%2Fclaude', name: 'Claude Code', models: [claudeSonnet, { id: 'auto', name: 'Auto' }] },
];

describe('MobileModelPickerPanel stairs layout', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderPanel = async (props: Partial<React.ComponentProps<typeof MobileModelPickerPanel>> = {}) => {
    await act(async () => root.render(
      <MobileModelPickerPanel
        open
        onClose={() => undefined}
        selectedProviderID=""
        selectedModelID=""
        resolveSelectedVariant={() => undefined}
        onSelect={() => undefined}
        providers={providers}
        favoriteModels={[]}
        recentModels={[]}
        isFavorite={() => false}
        onToggleFavorite={() => undefined}
        {...props}
      />,
    ));
  };

  const search = async (value: string) => {
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const rowNames = () => Array.from(container.querySelectorAll('.typography-meta.font-medium.text-foreground')).map((node) => node.textContent);

  test('shows a provider rail and flat labelled groups without accordion toggles', async () => {
    await renderPanel();
    const labels = Array.from(container.querySelectorAll('.model-picker-rail button')).map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['chat.modelControls.modeValue.all', 'Anthropic', 'Claude Code']);
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect(container.textContent).toContain('Claude Opus');
    expect(container.textContent).toContain('Auto');
  });

  test('lifts the selected provider to the first group and rail slot', async () => {
    await renderPanel({ selectedProviderID: 'magpie-remote-magpie%2Fvps-us%2Fclaude', selectedModelID: 'auto' });
    const labels = Array.from(container.querySelectorAll('.model-picker-rail button')).map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['chat.modelControls.modeValue.all', 'Claude Code', 'Anthropic']);
    expect(Array.from(container.querySelectorAll('[data-rail-section]')).map((node) => (node as HTMLElement).dataset.railSection))
      .toEqual(['all', 'magpie-remote-magpie%2Fvps-us%2Fclaude', 'anthropic']);
  });

  test('keeps the optional clear action pinned and the multi-run counts independent from selection', async () => {
    const clear = vi.fn();
    const onSelect = vi.fn();
    await renderPanel({
      clearSelection: { label: 'Clear model', onSelect: clear },
      selectionCount: (_, modelID) => modelID === claudeOpus.id ? 2 : 0,
      onSelect,
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const clearButton = buttons.find((button) => button.textContent === 'Clear model')!;
    const opus = buttons.find((button) => button.textContent?.includes(claudeOpus.name))!;
    expect(clearButton.closest('[data-testid="scroller"]')).toBeNull();
    expect(opus.parentElement?.textContent).toContain('x2');
    await act(async () => clearButton.click());
    expect(clear).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => opus.click());
    expect(onSelect).toHaveBeenCalledWith('anthropic', claudeOpus.id, undefined);
  });

  test('ranks search results by recent usage and matches provider ID plus model name', async () => {
    const recent: ModelPickerEntry[] = [{ providerID: 'magpie-remote-magpie%2Fvps-us%2Fclaude', modelID: claudeSonnet.id, model: claudeSonnet }];
    await renderPanel({ recentModels: recent, recencyOrder: recent });
    await search('claude');
    expect(container.querySelector('[data-rail-section]')).toBeNull();
    expect(rowNames()[0]).toBe('Claude Sonnet 5.5');
    await search('vpsus sonnet');
    expect(rowNames()).toEqual(['Claude Sonnet 5.5']);
  });

  test('selected model counts as the most recent use when ranking', async () => {
    await renderPanel({ selectedProviderID: 'anthropic', selectedModelID: 'haiku' });
    await search('claude');
    expect(rowNames()[0]).toBe('Claude Haiku');
  });

  test('search mounts one page of ranked rows and pages more in near the bottom', async () => {
    const bulk: ModelPickerProvider[] = [{
      id: 'bulk',
      name: 'Bulk',
      models: Array.from({ length: 150 }, (_, index) => ({ id: `claude-${index}`, name: `Claude ${index}` })),
    }];
    await renderPanel({ providers: bulk });
    await search('claude');
    expect(rowNames()).toHaveLength(40);
    const scroller = container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    await act(async () => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(rowNames()).toHaveLength(80);
    await search('claude 1');
    expect(rowNames()).toHaveLength(40);
  });

  test('rail highlight changes do not re-render model rows', async () => {
    await renderPanel();
    const before = rowRenders.count;
    const button = container.querySelector<HTMLButtonElement>('.model-picker-rail button[aria-label="Claude Code"]')!;
    await act(async () => button.click());
    expect(button.getAttribute('aria-current')).toBe('true');
    expect(rowRenders.count).toBe(before);
  });

  test('tapping a rail entry scrolls to that provider and keeps it active', async () => {
    await renderPanel();
    const scroller = container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    const target = container.querySelector<HTMLElement>('[data-rail-section="anthropic"]')!;
    target.getBoundingClientRect = () => ({ top: 420 } as DOMRect);
    scroller.getBoundingClientRect = () => ({ top: 20 } as DOMRect);
    const button = container.querySelector<HTMLButtonElement>('.model-picker-rail button[aria-label="Anthropic"]')!;
    await act(async () => button.click());
    expect(scroller.scrollTop).toBe(400);
    expect(button.getAttribute('aria-current')).toBe('true');
    await act(async () => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(button.getAttribute('aria-current')).toBe('true');
  });
});
