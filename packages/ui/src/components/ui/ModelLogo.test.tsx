import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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

  it('preserves an explicit caller fallback', () => {
    const html = renderToStaticMarkup(
      <ModelLogo modelId="unknown-model" fallback={<span data-custom-fallback />} />,
    );

    expect(html).toContain('data-custom-fallback');
    expect(html).not.toContain('#yuri-brain-ai-3');
  });
});
