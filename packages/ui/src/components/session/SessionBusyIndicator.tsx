import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared busy/streaming spinner ring used by both PC sidebar and mobile sessions
 * UIs. Geometry and theme tokens match the PC SessionNodeItem trailing-status
 * ring exactly — same viewBox, stroke width, arc length, and CSS custom-property
 * tokens so the indicator reads identically on dark and light themes across
 * platforms.
 *
 * When used inside a stop button the caller is responsible for wrapping it
 * with the stop aria-label; this component only renders the visual ring.
 */
interface SessionBusyIndicatorProps {
  /** Outer size in px (default 14, matching PC SessionNodeItem ring). */
  size?: number;
  className?: string;
}

export const SessionBusyIndicator: React.FC<SessionBusyIndicatorProps> = ({
  size = 14,
  className,
}) => {
  const strokeWidth = 1.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.28;

  return (
    <span
      className={cn('inline-flex items-center justify-center shrink-0', className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="animate-spin yuri-busy-ring"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--interactive-border)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-muted-foreground)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference - arc}`}
        />
      </svg>
    </span>
  );
};

SessionBusyIndicator.displayName = 'SessionBusyIndicator';
