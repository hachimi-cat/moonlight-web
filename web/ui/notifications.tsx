import * as React from "react"
import { createRoot, type Root } from "react-dom/client"

import { Toast, type ToastLevel } from "./components/toast"
import "./tailwind.tw.css"

/*
 * The notification stack, rendered by React into the existing
 * `#notification-list` element.
 *
 * `notification.ts` keeps its exported `showNotification()` signature and
 * delegates here, so the ~dozens of call sites across the app are untouched.
 */

const REMOVAL_TIME_MS = 10000

type Entry = { id: number; message: string; level: ToastLevel }

let nextId = 1
let entries: Entry[] = []
let root: Root | null = null

function render() {
    root?.render(
        <div className="pw-root flex flex-col items-end gap-2">
            {entries.map((e) => (
                <Toast
                    key={e.id}
                    message={e.message}
                    level={e.level}
                    onDismiss={() => dismiss(e.id)}
                />
            ))}
        </div>,
    )
}

function dismiss(id: number) {
    const before = entries.length
    entries = entries.filter((e) => e.id !== id)
    // A toast can be dismissed by hand and then again by its timer; only
    // re-render if something actually changed.
    if (entries.length !== before) render()
}

/** Attach the stack to its host element. Safe to call more than once. */
export function mountNotifications(host: HTMLElement) {
    if (root) return
    root = createRoot(host)
    render()
}

export function pushNotification(message: string, level: ToastLevel) {
    const entry: Entry = { id: nextId++, message, level }
    entries = [...entries, entry]
    render()

    setTimeout(() => dismiss(entry.id), REMOVAL_TIME_MS)
}
