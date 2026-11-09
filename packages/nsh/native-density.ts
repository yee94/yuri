/** Web applyPadding uses sqrt(percent / 100); fonts, px and environment geometry
 * are separate owners. These are explicit layout consumers, never a style walker. */
export function nativePadding(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 50 || value > 200) throw new Error('Invalid Host padding scale');
  return Math.round(value);
}

export function nativeDensityScale(padding = 100): number { return Math.sqrt(padding / 100); }

export function nativeLayoutDensity(padding = 100) {
  const scale = nativeDensityScale(padding);
  return {
    scale,
    pages: {
      // Web Settings workspace variables are literal rem custom properties.
      settings: { paddingHorizontal: 18, paddingTop: 12 * scale, paddingBottom: 24, gap: 20 },
      settingsEntity: { paddingHorizontal: 18 + 12 * scale, paddingTop: 12 * scale, paddingBottom: 12 * scale, gap: 20 },
      settingsHome: { paddingHorizontal: 18, paddingTop: 16, gap: 20 },
      editor: { paddingHorizontal: 18, paddingTop: 16 * scale, paddingBottom: 24, gap: 20 },
      sheetEditor: { padding: 20 * scale, paddingBottom: 40 * scale, gap: 16 * scale },
      sheetPicker: { padding: 20 * scale, gap: 12 * scale },
      sheetSimple: { padding: 20 * scale, gap: 16 * scale },
      projectDetail: { padding: 16 * scale, gap: 16 * scale },
      channels: { gap: 16 * scale, paddingBottom: 32 * scale },
      assistantCatalog: { paddingHorizontal: 18, gap: 14 * scale },
      scheduledHistory: { paddingHorizontal: 18, paddingTop: 16 * scale, gap: 16 * scale },
      scheduledTasks: { paddingHorizontal: 18, paddingTop: 20 * scale, gap: 16 * scale },
      taskHistory: { paddingHorizontal: 12 * scale, paddingBottom: 24 * scale, gap: 12 * scale },
      modelPicker: { paddingHorizontal: 8 * scale, paddingBottom: 24 * scale, gap: 8 * scale },
      voiceTest: { padding: 20 * scale, gap: 20 * scale },
    },
    forms: {
      group: { gap: 8 }, groupLabel: { paddingHorizontal: 8 },
      card: { padding: 12 * scale, gap: 8 * scale },
      stack: { gap: 12 * scale }, compact: { gap: 8 * scale }, inline: { gap: 8 * scale },
      action: { minHeight: Math.max(44, 44 * scale), paddingHorizontal: 16 * scale, paddingVertical: 12 * scale },
      quiet: { minHeight: Math.max(44, 44 * scale), paddingHorizontal: 12 * scale, paddingVertical: 8 * scale },
      worktree: { minHeight: Math.max(44, 56 * scale) },
      session: { minHeight: Math.max(36, 48 * scale), paddingHorizontal: 12 * scale, paddingVertical: 12 * scale, gap: 8 * scale },
      rowGap: { gap: 4 * scale },
      historyCard: { padding: 16 * scale, gap: 8 * scale },
      readAction: { minHeight: 44, padding: 12 * scale, gap: 8 * scale },
      taskRow: { minHeight: Math.max(44, 56 * scale), paddingVertical: 8 * scale, gap: 4 * scale },
      optionRow: { minHeight: Math.max(44, 56 * scale), paddingHorizontal: 12 * scale, paddingVertical: 12 * scale, gap: 12 * scale },
    },
    select: {
      content: { padding: 16 * scale, gap: 12 * scale }, header: { gap: 8 * scale },
      group: { paddingHorizontal: 12 * scale, paddingVertical: 8 * scale },
      item: { minHeight: Math.max(36, 48 * scale), paddingHorizontal: 12 * scale },
      compactItem: { minHeight: Math.max(44, 44 * scale) },
      label: { gap: 8 * scale },
    },
    sheetSpacing: {
      'p-2': { padding: 8 * scale }, 'p-3': { padding: 12 * scale },
      'p-4': { padding: 16 * scale }, 'p-5': { padding: 20 * scale },
      'px-3': { paddingHorizontal: 12 * scale }, 'px-5': { paddingHorizontal: 20 * scale },
      'py-2': { paddingVertical: 8 * scale }, 'py-3': { paddingVertical: 12 * scale },
      'pb-4': { paddingBottom: 16 * scale },
      'gap-1': { gap: 4 * scale }, 'gap-2': { gap: 8 * scale },
      'gap-3': { gap: 12 * scale }, 'gap-4': { gap: 16 * scale },
    },
    settings: {
      section: { gap: 8 * scale }, label: { paddingHorizontal: 4 * scale },
      card: { padding: 16 * scale, gap: 12 * scale },
      field: { minHeight: Math.max(44, 48 * scale), paddingHorizontal: 12 * scale, paddingVertical: 12 * scale },
      popup: { padding: 12 * scale },
      toggle: { minHeight: Math.max(44, 48 * scale), gap: 12 * scale },
      choiceLabel: { paddingHorizontal: 8 * scale }, options: { gap: 12 * scale },
      option: { padding: 12 * scale, gap: 4 * scale, minHeight: 36 },
      transport: { paddingHorizontal: 14 * scale, paddingVertical: 12 * scale, gap: 8 * scale },
      chips: { gap: 4 * scale }, chip: { minHeight: Math.max(36, 36 * scale), paddingHorizontal: 8 * scale },
      radio: { minHeight: Math.max(36, 52 * scale), paddingHorizontal: 14 * scale, paddingVertical: 12 * scale, gap: 8 * scale },
      preview: { marginTop: 8 * scale, padding: 8 * scale, gap: 6 * scale },
    },
    chat: {
      transcript: { paddingHorizontal: 12 * scale, paddingTop: 26, gap: 20 * scale },
      composerOuter: { paddingHorizontal: 12 * scale, paddingTop: 8 * scale },
      composerSurface: { paddingHorizontal: 12 * scale, paddingTop: 4 * scale, paddingBottom: 4 * scale },
      status: { gap: 8 * scale, paddingHorizontal: 12 * scale, paddingVertical: 2 * scale },
      actions: { minHeight: Math.max(36, 40 * scale), gap: 6 * scale },
      input: { maxHeight: 104 * scale },
      welcome: { paddingHorizontal: 24 * scale, paddingVertical: 16 * scale, gap: 16 * scale },
      compact: { paddingHorizontal: 8 * scale, gap: 4 * scale },
      send: { target: 32 * scale, disc: 24 * scale, ghost: 16 * scale, hitSlop: Math.max(6, (44 - 32 * scale) / 2) },
    },
  };
}

/** Finite Web spacing-token map for existing Sheet/Select class contracts.
 * Never inspects inline styles, parses numeric values, expands custom properties,
 * or touches system geometry, radii, fonts and arbitrary px classes. */
export function nativeSheetSpacing(classes: string | null | undefined, density: ReturnType<typeof nativeLayoutDensity>) {
  const tokens = density.sheetSpacing;
  const known = (key: string): key is keyof typeof tokens => Object.prototype.hasOwnProperty.call(tokens, key);
  return (classes ?? '').split(/\s+/).filter(known).map(key => tokens[key]);
}
