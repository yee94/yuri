import React from 'react';
import { useModelLogo } from '@/hooks/useModelLogo';
import { cn } from '@/lib/utils';

interface ModelLogoProps {
  modelId: string | null | undefined;
  providerId?: string | null;
  alt?: string;
  className?: string;
  onError?: () => void;
  fallback?: React.ReactNode;
}

/**
 * 按模型品牌显示 logo（聚合渠道下优先模型名匹配，Provider 仅作兜底）
 */
export const ModelLogo: React.FC<ModelLogoProps> = ({
  modelId,
  providerId,
  alt,
  className,
  onError: externalOnError,
  fallback,
}) => {
  const { src, onError: handleInternalError, hasLogo, brand } = useModelLogo(modelId, providerId);
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
    return <>{fallback ?? null}</>;
  }

  // Paint as a currentColor mask instead of brightness-0/invert.
  // iOS WKWebView can drop CSS filters on children of animated/
  // backdrop-filtered overlays, leaving black marks invisible on dark surfaces.
  return (
    <span
      role="img"
      aria-label={alt || `${brand || modelId || providerId || 'model'} logo`}
      className={cn('inline-block shrink-0 bg-foreground', className)}
      style={{
        mask: `url("${src}") center / contain no-repeat`,
        WebkitMask: `url("${src}") center / contain no-repeat`,
      }}
      draggable={false}
    />
  );
};
