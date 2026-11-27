import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModelLogo } from './ModelLogo';

describe('ModelLogo', () => {
  it('uses the monochrome foreground fallback when no bundled mark matches', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <ModelLogo modelId="unknown-model" providerId="unknown-provider" className="size-4 shrink-0" />,
    );

    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelector('use')?.getAttribute('href')).toBe('#yuri-brain-ai-3');
    expect(container.querySelector('svg')?.classList.contains('text-foreground')).toBe(true);
    expect(container.querySelector('svg')?.classList.contains('size-4')).toBe(true);
  });

  it('probes a shared logo URL once across many mounted rows', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const RealImage = globalThis.Image;
    let probes = 0;
    vi.stubGlobal('Image', class extends RealImage {
      constructor() {
        super();
        probes += 1;
      }
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(
      <>
        {Array.from({ length: 5 }, (_, index) => <ModelLogo key={index} modelId="claude-opus-4" providerId="anthropic" />)}
      </>,
    ));
    expect(probes).toBeLessThanOrEqual(1);
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('preserves an explicit caller fallback', () => {
    const html = renderToStaticMarkup(
      <ModelLogo modelId="unknown-model" fallback={<span data-custom-fallback />} />,
    );

    expect(html).toContain('data-custom-fallback');
    expect(html).not.toContain('#yuri-brain-ai-3');
  });
});
