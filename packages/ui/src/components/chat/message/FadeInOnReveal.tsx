import React from 'react';
import { cn } from '@/lib/utils';

interface FadeInOnRevealProps {
    children: React.ReactNode;
    className?: string;
    skipAnimation?: boolean;
    forceAnimation?: boolean;
    ignoreContextDisabled?: boolean;
    respectReducedMotion?: boolean;
}

const FADE_ANIMATION_ENABLED = false;

// Context to allow parent components (like VirtualMessageList) to disable animations
// for items entering the viewport due to scrolling rather than new content
const FadeInDisabledContext = React.createContext(false);

export const FadeInDisabledProvider: React.FC<{ disabled: boolean; children: React.ReactNode }> = ({ disabled, children }) => (
    <FadeInDisabledContext.Provider value={disabled}>
        {children}
    </FadeInDisabledContext.Provider>
);

type AnimatedFadeInProps = Pick<FadeInOnRevealProps, 'children' | 'className'> & { animate?: boolean };

const AnimatedFadeIn: React.FC<AnimatedFadeInProps> = ({ children, className, animate = true }) => {
    // Consume is bookkeeping, not a new reveal. Keep both the DOM and the
    // mount-time animation decision when the parent changes skipAnimation.
    const [animateOnMount] = React.useState(animate);

    return (
        <div
            className={cn(
                'w-full',
                animateOnMount && 'animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out',
                className
            )}
        >
            {children}
        </div>
    );
};

export const FadeInOnReveal: React.FC<FadeInOnRevealProps> = ({
    children,
    className,
    skipAnimation,
    forceAnimation = false,
    ignoreContextDisabled = false,
    respectReducedMotion = false,
}) => {
    const contextDisabled = React.useContext(FadeInDisabledContext);
    const reducedMotion =
        respectReducedMotion &&
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldSkip = Boolean(skipAnimation) || (!ignoreContextDisabled && contextDisabled) || reducedMotion;
    const animationEnabled = FADE_ANIMATION_ENABLED || forceAnimation;

    if (forceAnimation) {
        return <AnimatedFadeIn className={className} animate={!shouldSkip}>{children}</AnimatedFadeIn>;
    }

    if (!animationEnabled || shouldSkip) {
        return <>{children}</>;
    }

    return <AnimatedFadeIn className={className}>{children}</AnimatedFadeIn>;
};
