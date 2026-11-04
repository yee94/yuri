import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, bordered, placeholder, endAdornment, ...props }: React.ComponentProps<"input"> & {
  bordered?: boolean;
  endAdornment?: React.ReactNode;
}) {
  const input = (
    <input
      type={type}
      data-slot="input"
      data-bordered={bordered}
      placeholder={placeholder || " "}
      className={cn(
        "text-foreground file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground bg-[var(--surface-elevated)] appearance-none flex h-9 w-full min-w-0 rounded-lg px-3 py-1 typography-markdown outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:typography-ui-label file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:typography-ui-label",
        // AlignUI-style ring border + transitions
        "ring-1 ring-inset ring-border/60 transition duration-200 ease-out",
        "hover:[&:not(:focus)]:bg-[var(--surface-subtle)] hover:[&:not(:focus)]:ring-transparent",
        "focus:ring-2 focus:ring-[var(--interactive-focus-ring)] focus-visible:outline-none",
        "aria-invalid:ring-[var(--status-error)] aria-invalid:focus:ring-[var(--status-error)]",
        bordered !== undefined && "border border-transparent ring-0 focus:ring-0 aria-invalid:ring-1 aria-invalid:focus:ring-1",
        bordered && "border-[var(--form-surface-border)]",
        className,
        endAdornment && "pe-11"
      )}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      {...props}
    />
  )

  if (!endAdornment) return input

  return (
    <div data-slot="input-wrapper" className="relative min-w-0 w-full flex-1">
      {input}
      <div data-slot="input-end-adornment" className="absolute inset-y-0 end-0 flex items-center">
        {endAdornment}
      </div>
    </div>
  )
}

export { Input }
