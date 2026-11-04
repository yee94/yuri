import { createContext } from 'react';

type GuiAppearanceContextValue = {
    logo?: string;
};
export const GuiAppearanceContext = createContext<GuiAppearanceContextValue | null>(null);
