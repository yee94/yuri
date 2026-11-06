import { create } from 'zustand';
import { getRuntimeGeneration } from '@/lib/runtime-switch';
import { normalizeExternalHttpUrl } from '@/lib/url';

type Target = { url: string; generation: number };
export const useMobileHtmlPreviewStore = create<{
  target: Target | null;
  open: (url: string) => void;
  close: () => void;
}>(set => ({
  target: null,
  open: input => {
    const url = normalizeExternalHttpUrl(input);
    if (url) set({ target: { url, generation: getRuntimeGeneration() } });
  },
  close: () => set({ target: null }),
}));
