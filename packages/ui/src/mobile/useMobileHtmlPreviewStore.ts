import { create } from 'zustand';
import { getRuntimeGeneration } from '@/lib/runtime-switch';
import { normalizeExternalHttpUrl } from '@/lib/url';
import type { HostLocation } from '@/lib/remote-projects/location';

type Target = { url: string; generation: number; location?: HostLocation };
export const useMobileHtmlPreviewStore = create<{
  target: Target | null;
  open: (url: string, location?: HostLocation) => void;
  close: () => void;
}>(set => ({
  target: null,
  open: (input, location) => {
    const url = normalizeExternalHttpUrl(input);
    if (url) set({ target: { url, generation: getRuntimeGeneration(), ...(location ? { location: { ...location } } : {}) } });
  },
  close: () => set({ target: null }),
}));
