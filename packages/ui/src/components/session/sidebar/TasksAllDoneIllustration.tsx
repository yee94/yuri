import React from 'react';
import { cn } from '@/lib/utils';

export function TasksAllDoneIllustration({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 120"
      className={cn('size-28 text-muted-foreground', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="60" cy="62" r="44" fill="currentColor" fillOpacity="0.06" stroke="none" />
      <g transform="rotate(-7 56 56)">
        <rect x="32" y="24" width="48" height="62" rx="9" fill="currentColor" fillOpacity="0.1" strokeOpacity="0.55" />
        <path d="M48 24v-3.5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3V24" strokeOpacity="0.55" />
        <path d="M41 42l3 3 5.5-6.5" />
        <path d="M55 42h15" strokeOpacity="0.5" />
        <path d="M41 56l3 3 5.5-6.5" />
        <path d="M55 56h11" strokeOpacity="0.5" />
        <path d="M41 70l3 3 5.5-6.5" />
        <path d="M55 70h14" strokeOpacity="0.5" />
      </g>
      <circle cx="82" cy="80" r="17" fill="currentColor" stroke="none" />
      <path d="M74 80.5l6 6 10-12" stroke="var(--background)" strokeWidth="3.5" />
      <path
        d="M22 30q0 6-6 6q6 0 6 6q0-6 6-6q-6 0-6-6z"
        fill="currentColor"
        stroke="none"
        fillOpacity="0.8"
      />
      <path
        d="M98 22q0 4-4 4q4 0 4 4q0-4 4-4q-4 0-4-4z"
        fill="currentColor"
        stroke="none"
        fillOpacity="0.6"
      />
      <circle cx="14" cy="72" r="2.2" fill="currentColor" stroke="none" fillOpacity="0.5" />
      <circle cx="106" cy="54" r="2" fill="currentColor" stroke="none" fillOpacity="0.5" />
      <path d="M100 100l5 4" strokeOpacity="0.45" />
      <path d="M18 96l5-3" strokeOpacity="0.45" />
      <path d="M108 74l1 6" strokeOpacity="0.4" />
    </svg>
  );
}
