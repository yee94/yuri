import { useEvent } from '@reactuses/core';
import { useState, useEffect } from 'react';
import { getProviderLogoCandidates } from '../lib/providerBrand';

type LogoSource = 'local' | 'none';

interface UseProviderLogoReturn {
    src: string | null;
    onError: () => void;
    hasLogo: boolean;
}

const localLogoModules = import.meta.glob<string>('../assets/provider-logos/*.svg', {
    eager: true,
    import: 'default',
});

const LOCAL_PROVIDER_LOGO_MAP = new Map<string, string>();
const PRELOADED_LOGO_SRCS = new Set<string>();
const AVAILABLE_PROVIDER_LOGOS = new Set<string>();

const buildLogoCandidates = (providerId: string | null | undefined) => getProviderLogoCandidates(providerId, AVAILABLE_PROVIDER_LOGOS);

const resolveProviderLogoSrc = (providerId: string | null | undefined): string | null => {
    const candidates = buildLogoCandidates(providerId);
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    return localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;
};

const preloadProviderLogo = (providerId: string | null | undefined): void => {
    if (typeof Image === 'undefined') return;
    const src = resolveProviderLogoSrc(providerId);
    if (!src || PRELOADED_LOGO_SRCS.has(src)) return;

    PRELOADED_LOGO_SRCS.add(src);
    const image = new Image();
    image.decoding = 'async';
    image.onerror = () => {
        PRELOADED_LOGO_SRCS.delete(src);
    };
    image.src = src;
    void image.decode?.().catch(() => undefined);
};

export const preloadProviderLogos = (providerIds: readonly (string | null | undefined)[]): void => {
    for (const providerId of providerIds) {
        preloadProviderLogo(providerId);
    }
};

for (const [path, url] of Object.entries(localLogoModules)) {
    const match = path.match(/provider-logos\/([^/]+)\.svg$/i);
    if (match?.[1] && url) {
        LOCAL_PROVIDER_LOGO_MAP.set(match[1].toLowerCase(), url);
        AVAILABLE_PROVIDER_LOGOS.add(match[1].toLowerCase());
    }
}

export function useProviderLogo(providerId: string | null | undefined): UseProviderLogoReturn {
    const candidates = buildLogoCandidates(providerId);
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    const hasLocalLogo = Boolean(localResolvedId);
    const localLogoSrc = localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;

    const [source, setSource] = useState<LogoSource>(hasLocalLogo ? 'local' : 'none');

    useEffect(() => {
        setSource(hasLocalLogo ? 'local' : 'none');
    }, [hasLocalLogo, localResolvedId]);

    const handleError = useEvent(() => {
        setSource('none');
    });

    if (!localResolvedId) {
        return { src: null, onError: handleError, hasLogo: false };
    }

    if (source === 'local' && localLogoSrc) {
        return {
            src: localLogoSrc,
            onError: handleError,
            hasLogo: true,
        };
    }

    return { src: null, onError: handleError, hasLogo: false };
}
