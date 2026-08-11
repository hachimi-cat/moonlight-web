import * as React from "react"
import { AlertTriangle, Info, X, XCircle } from "lucide-react"

import { cn } from "../lib/cn"

export type ToastLevel = "error" | "warn" | "info"

const LEVEL: Record<
    ToastLevel,
    { icon: React.ComponentType<{ className?: string }>; accent: string; ring: string }
> = {
    error: { icon: XCircle, accent: "text-pw-danger", ring: "border-pw-danger/40" },
    warn: { icon: AlertTriangle, accent: "text-amber-400", ring: "border-amber-400/40" },
    info: { icon: Info, accent: "text-pw-accent", ring: "border-pw-accent/40" },
}

export function Toast(props: { message: string; level: ToastLevel; onDismiss: () => void }) {
    const { message, level, onDismiss } = props
    const { icon: Icon, accent, ring } = LEVEL[level] ?? LEVEL.error

    return (
        <div
            role={level === "error" ? "alert" : "status"}
            className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-3",
                "rounded-[var(--radius-pw)] border bg-pw-surface/95 px-3.5 py-3",
                "shadow-lg shadow-black/40 backdrop-blur-sm",
                ring,
            )}
        >
            <Icon className={cn("mt-0.5 size-4 shrink-0", accent)} />
            {/* Server messages can be long single tokens; wrap rather than overflow. */}
            <p className="min-w-0 flex-1 break-words text-sm leading-snug text-pw-fg">{message}</p>
            <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className={cn(
                    "-mr-1 -mt-1 shrink-0 rounded p-1 text-pw-muted transition-colors",
                    "hover:bg-pw-surface-2 hover:text-pw-fg",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-accent/40",
                )}
            >
                <X className="size-3.5" />
            </button>
        </div>
    )
}
