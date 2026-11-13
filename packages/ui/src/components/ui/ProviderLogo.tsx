import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
}

/** Generic stack mark when a provider has no local logo asset. */
const ProviderLogoFallback: React.FC<{ className?: string }> = ({ className }) => (
    <Icon name="stack" className={cn('text-muted-foreground', className)} />
);

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError
}) => {
    const { src, onError: handleInternalError, hasLogo } = useProviderLogo(providerId);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
        setFailed(false);
    }, [src]);

    React.useEffect(() => {
        if (!src || typeof Image === 'undefined') return;
        let cancelled = false;
        const image = new Image();
        image.onerror = () => {
            if (cancelled) return;
            setFailed(true);
            handleInternalError();
            externalOnError?.();
        };
        image.src = src;
        return () => {
            cancelled = true;
        };
    }, [src, handleInternalError, externalOnError]);

    if (!hasLogo || !src || failed) {
        return <ProviderLogoFallback className={className} />;
    }

    // Paint as a currentColor mask instead of brightness-0/invert.
    // iOS WKWebView can drop CSS filters on children of animated/
    // backdrop-filtered overlays (usage metadata sheet), leaving black marks
    // invisible on dark surfaces.
    return (
        <span
            role="img"
            aria-label={alt || `${providerId} logo`}
            className={cn('inline-block shrink-0 bg-foreground', className)}
            style={{
                mask: `url("${src}") center / contain no-repeat`,
                WebkitMask: `url("${src}") center / contain no-repeat`,
            }}
            draggable={false}
        />
    );
};
