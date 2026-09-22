export type MouseScrollMode = "highres" | "normal"

// Moonlight/Windows wheel units: 120 per notch, normally 3 lines.
// Pixel deltas keep the existing 1:1 gain; they are CSS pixels, never
// multiplied by host resolution or devicePixelRatio. Sensitivity is explicit.
const WHEEL_NOTCH = 120
const WHEEL_LINE = WHEEL_NOTCH / 3
const MAX_PACKET_DELTA = 32760 // fits i16 and is also a whole number of notches

export type WheelSample = {
    atMs: number, gapMs: number | null, processingMs: number | null,
    unit: number, rawX: number, rawY: number, sentX: number, sentY: number,
    cancelable: boolean,
}

export function validScrollSensitivity(value: number): number {
    return Number.isFinite(value) ? Math.min(4, Math.max(0.25, value)) : 1
}

export class WheelScroll {
    private remainderX = 0
    private remainderY = 0
    private lastAt: number | null = null
    private samples: WheelSample[] = []
    private events = 0

    reset() {
        this.remainderX = this.remainderY = 0
        this.lastAt = null
    }

    take(event: WheelEvent, viewport: { width: number, height: number }, mode: MouseScrollMode, sensitivity: number) {
        // Read deltaMode BEFORE deltaX/Y; browsers may change the returned
        // units when deltaMode is accessed (per the WheelEvent contract).
        const unit = event.deltaMode
        const rawX = event.deltaX, rawY = event.deltaY
        if (![0, 1, 2].includes(unit) || !Number.isFinite(rawX) || !Number.isFinite(rawY)) return null
        const now = performance.now()
        const gap = this.lastAt === null ? null : Math.max(0, now - this.lastAt)
        // Don't carry a partial notch from an old gesture into a new one.
        if (gap !== null && gap > 500) this.remainderX = this.remainderY = 0
        this.lastAt = now
        const gain = validScrollSensitivity(sensitivity)
        const scaleX = unit === 1 ? WHEEL_LINE : unit === 2 ? Math.max(1, viewport.width) : 1
        const scaleY = unit === 1 ? WHEEL_LINE : unit === 2 ? Math.max(1, viewport.height) : 1
        const bounded = (value: number) => Math.min(MAX_PACKET_DELTA, Math.max(-MAX_PACKET_DELTA, value)) || 0
        const x = bounded(rawX * scaleX * gain), y = bounded(-rawY * scaleY * gain)
        // Direction reversal must react immediately, not fight old remainder.
        if (x * this.remainderX < 0) this.remainderX = 0
        if (y * this.remainderY < 0) this.remainderY = 0
        this.remainderX += x
        this.remainderY += y
        const quantum = mode === "normal" ? WHEEL_NOTCH : 1
        const sentX = bounded(Math.trunc(this.remainderX / quantum) * quantum)
        const sentY = bounded(Math.trunc(this.remainderY / quantum) * quantum)
        this.remainderX -= sentX
        this.remainderY -= sentY
        const delay = now - event.timeStamp
        this.samples.push({
            atMs: Date.now(), gapMs: gap === null ? null : Math.round(gap),
            processingMs: Number.isFinite(delay) && delay >= 0 && delay < 60_000 ? Math.round(delay) : null,
            unit, rawX, rawY, sentX, sentY, cancelable: event.cancelable,
        })
        if (this.samples.length > 32) this.samples.shift()
        this.events++
        return { x: sentX, y: sentY }
    }

    diagnostics(mode: MouseScrollMode, sensitivity: number) {
        return { version: 1, events: this.events, mode, sensitivity, samples: this.samples.slice() }
    }
}
