import { readMarkstreamReactEnabled } from '@/stores/useFeatureFlagsStore';
import { preloadMarkstreamRenderer } from './markstreamRendererLoader';

let markdownRendererModulePromise: Promise<typeof import('./MarkdownRendererImpl')> | null = null;

export const loadMarkdownRendererModule = () => {
  markdownRendererModulePromise ??= import('./MarkdownRendererImpl').catch((error) => {
    markdownRendererModulePromise = null;
    throw error;
  });
  return markdownRendererModulePromise;
};

export const preloadMarkdownRenderer = () => {
  if (readMarkstreamReactEnabled()) {
    preloadMarkstreamRenderer();
  } else {
    void loadMarkdownRendererModule().catch(() => undefined);
  }
};
