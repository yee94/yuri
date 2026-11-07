const aliases = new Map<string, string>([
    ['codex', 'openai'], ['chatgpt', 'openai'], ['claude', 'anthropic'],
    ['gemini', 'google'], ['evroc-ai', 'evroc'], ['evrocai', 'evroc'],
    ['ollama-cloud', 'ollama'], ['opencode-go', 'opencode'], ['grok', 'xai'],
    ['supergrok', 'xai'], ['zcode', 'zai-coding-plan'], ['wafer-ai', 'wafer.ai'], ['wafer', 'wafer.ai'],
]);

/** Shared candidate order; each runtime supplies its actual local artwork catalog. */
export function getProviderLogoCandidates(providerId: string | null | undefined, available: ReadonlySet<string>): string[] {
    const fallback = providerId?.toLowerCase().includes('magpie') ? ['magpie'] : [];
    let brandId = providerId;
    const magpie = providerId?.match(/^magpie:[^:]+:(.+)$/i);
    if (magpie) {
        try { brandId = decodeURIComponent(magpie[1]); }
        catch { return fallback; }
    }
    const normalized = (brandId ?? '').toLowerCase().trim().replace(/^models\./, '').replace(/^provider\./, '').replace(/\s+/g, '-');
    if (!normalized) return fallback;
    const compact = normalized.replace(/[^a-z0-9_\-./:]/g, '');
    const primary = compact.split(/[/:]/)[0] || compact;
    const candidates = [aliases.get(compact), aliases.get(primary), compact, primary].filter((value): value is string => Boolean(value));
    for (const keyword of normalized.split(/[^a-z0-9]+/)) {
        const brand = aliases.get(keyword) ?? keyword;
        if (available.has(brand)) candidates.push(brand);
    }
    return [...new Set(candidates.filter(candidate => candidate !== 'magpie')), ...fallback];
}
