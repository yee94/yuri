import { createContext } from 'react';
import type { TranscriptSearchMatch } from './lib/transcriptSearch';

export const TranscriptSearchContext = createContext<(TranscriptSearchMatch & { navigationId?: number }) | null>(null);
