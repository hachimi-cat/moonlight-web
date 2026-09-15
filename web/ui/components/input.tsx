import * as React from "react"

import { cn } from "../lib/cn"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
    ({ className, type, ...props }, ref) => (
        <input
            ref={ref}
            type={type}
            className={cn(
                "flex h-9 w-full rounded-[var(--radius-pw)] border border-pw-border",
                "bg-pw-surface-2 px-3 py-1 text-sm text-pw-fg outline-none transition-colors",
                "placeholder:text-pw-muted",
                "hover:border-pw-accent/60",
                "focus-visible:border-pw-accent focus-visible:ring-2 focus-visible:ring-pw-accent/35",
                "disabled:cursor-not-allowed disabled:opacity-50",
                // The spinners are unusable at this size and the slider covers
                // the same job; hide them rather than fight per-engine styling.
                "[&::-webkit-inner-spin-button]:appearance-none",
                "[&::-webkit-outer-spin-button]:appearance-none",
                "[-moz-appearance:textfield]",
                // File inputs keep the native picker (it cannot be replaced),
                // but the button it renders can at least match.
                "file:mr-3 file:cursor-pointer file:rounded-md file:border-0",
                "file:bg-pw-surface file:px-3 file:py-1.5 file:text-sm file:text-pw-fg",
                className,
            )}
            {...props}
        />
    ),
)
Input.displayName = "Input"

export { Input }
