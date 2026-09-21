import { stopPropagationOn } from "./input_boundary"

export type PawpadoGamePresentation = {
    slug: string
    title: string
    machine: string
    quality: string
    fps: number
}

export function parsePawpadoGamePresentation(query: URLSearchParams): PawpadoGamePresentation | null {
    const slug = query.get("pawpadoGame") ?? ""
    const title = (query.get("pawpadoGameTitle") ?? "").trim()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !title) {
        return null
    }

    const rawFps = Number(query.get("pawpadoFps"))
    return {
        slug,
        title: title.slice(0, 120),
        machine: (query.get("pawpadoMachine") ?? "Computer").slice(0, 40),
        quality: (query.get("pawpadoQuality") ?? "Auto").slice(0, 24),
        fps: Number.isFinite(rawFps) && rawFps >= 15 && rawFps <= 240 ? rawFps : 60,
    }
}

function visibleGamepad(): Gamepad | null {
    try {
        return Array.from(navigator.getGamepads()).find(gamepad => gamepad != null) ?? null
    } catch {
        return null
    }
}

function isIOSWebKit(): boolean {
    const ua = navigator.userAgent
    return /iPad|iPhone|iPod/i.test(ua) ||
        (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
}

function isWindowsChrome(): boolean {
    return /Windows/i.test(navigator.userAgent) && /Chrome\//i.test(navigator.userAgent)
}

/**
 * Pawpado's game-first launch surface. It deliberately contains no portal or
 * Moonlight header: while a direct game is opening, the game art is the whole
 * context and the underlying desktop must never flash through.
 */
export class PawpadoLaunchOverlay {
    private root = document.createElement("section")
    private eyebrow = document.createElement("p")
    private title = document.createElement("h1")
    private status = document.createElement("p")
    private detail = document.createElement("p")
    private progress = document.createElement("div")
    private controller = document.createElement("section")
    private controllerStatus = document.createElement("p")
    private controllerHelp = document.createElement("div")
    private primary = document.createElement("button")
    private retry = document.createElement("button")
    // A real link is the final safety net: returning to the portal must still
    // work if the stream's control/API request is stalled. The click handler
    // only performs best-effort host cleanup and never owns navigation.
    private leave = document.createElement("a")
    private controllerCleanup: (() => void) | null = null
    private parent: HTMLElement | null = null

    constructor(readonly game: PawpadoGamePresentation) {
        this.root.className = "pw-game-launch"
        this.root.setAttribute("role", "dialog")
        this.root.setAttribute("aria-modal", "true")
        this.root.setAttribute("aria-labelledby", "pw-game-launch-title")

        const hero = document.createElement("img")
        hero.className = "pw-game-launch-hero"
        hero.src = `/games/heroes/${game.slug}.webp`
        hero.alt = ""
        hero.setAttribute("aria-hidden", "true")

        const shade = document.createElement("div")
        shade.className = "pw-game-launch-shade"

        const body = document.createElement("main")
        body.className = "pw-game-launch-body"

        const cover = document.createElement("img")
        cover.className = "pw-game-launch-cover"
        cover.src = `/games/${game.slug}.webp`
        cover.alt = ""

        const copy = document.createElement("div")
        copy.className = "pw-game-launch-copy"
        this.eyebrow.className = "pw-game-launch-eyebrow"
        this.eyebrow.textContent = "Preparing your game"
        this.title.id = "pw-game-launch-title"
        this.title.className = "pw-game-launch-title"
        this.title.textContent = game.title

        const facts = document.createElement("p")
        facts.className = "pw-game-launch-facts"
        const quality = game.quality == "4k" ? "4K" : game.quality
        facts.textContent = `${game.machine} · ${quality} · ${game.fps} FPS`

        const statusRow = document.createElement("div")
        statusRow.className = "pw-game-launch-status-row"
        const spinner = document.createElement("span")
        spinner.className = "pw-game-launch-spinner"
        spinner.setAttribute("aria-hidden", "true")
        this.status.className = "pw-game-launch-status"
        this.status.setAttribute("role", "status")
        this.status.setAttribute("aria-live", "polite")
        this.status.textContent = "Joining the secure stream…"
        statusRow.append(spinner, this.status)

        this.detail.className = "pw-game-launch-detail"
        this.detail.textContent = "Your desktop stays hidden while the game opens."

        this.progress.className = "pw-game-launch-progress"
        this.progress.innerHTML = "<span></span>"

        this.controller.className = "pw-game-launch-controller"
        this.controller.hidden = true
        const controllerLabel = document.createElement("p")
        controllerLabel.className = "pw-game-launch-controller-label"
        controllerLabel.textContent = "Controller check"
        this.controllerStatus.className = "pw-game-launch-controller-status"
        this.controllerStatus.setAttribute("aria-live", "polite")
        this.controller.append(controllerLabel, this.controllerStatus)

        this.controllerHelp.className = "pw-game-launch-controller-help"
        this.controllerHelp.hidden = true
        this.controllerHelp.innerHTML = "<strong>Controller not visible to Chrome</strong><ol><li>Open <code>chrome://flags/#enable-windows-gameinput-data-fetcher</code></li><li>Set <b>Enable GameInput data fetcher</b> to <b>Enabled</b></li><li>Completely relaunch Chrome with the controller already connected</li></ol>"
        this.controller.appendChild(this.controllerHelp)

        const actions = document.createElement("div")
        actions.className = "pw-game-launch-actions"
        this.primary.type = "button"
        this.primary.className = "pw-game-launch-button pw-game-launch-button-primary"
        this.primary.hidden = true
        this.retry.type = "button"
        this.retry.className = "pw-game-launch-button pw-game-launch-button-primary"
        this.retry.textContent = "Try again"
        this.retry.hidden = true
        this.leave.href = "/dashboard/games"
        this.leave.target = "_self"
        this.leave.className = "pw-game-launch-button pw-game-launch-button-quiet"
        this.leave.textContent = "Cancel launch"
        actions.append(this.primary, this.retry, this.leave)

        copy.append(
            this.eyebrow,
            this.title,
            facts,
            statusRow,
            this.detail,
            this.progress,
            this.controller,
            actions,
        )
        body.append(cover, copy)
        this.root.append(hero, shade, body)

        // Stream input handlers sit on document and aggressively prevent
        // defaults. Keep overlay taps/buttons local and usable on mobile.
        stopPropagationOn(this.root)
    }

    mount(parent: HTMLElement) {
        this.parent = parent
        if (!this.root.isConnected) parent.appendChild(this.root)
        this.root.hidden = false
        requestAnimationFrame(() => this.root.classList.add("pw-game-launch-visible"))
    }

    setCancelHandler(handler: () => void | Promise<void>) {
        this.leave.onclick = () => {
            void handler()
            // Direct launches normally live in a script-opened tab. Close it
            // while the trusted click is still active; if the browser refuses,
            // the anchor's native /dashboard/games navigation still happens.
            window.close()
        }
    }

    setRetryHandler(handler: () => void | Promise<void>) {
        this.retry.onclick = () => void handler()
    }

    setLaunchState(state: "preparing" | "starting" | "running", message?: string | null) {
        this.eyebrow.textContent = "Preparing your game"
        this.root.classList.remove("pw-game-launch-failed", "pw-game-launch-reconnect")
        this.progress.hidden = false
        if (state == "preparing") {
            this.status.textContent = "Preparing controls…"
            this.detail.textContent = message || "Setting up the game on your computer."
        } else if (state == "starting") {
            this.status.textContent = `Opening ${this.game.title}…`
            this.detail.textContent = message || "The game process is starting now."
        } else {
            this.status.textContent = "Game opened — waiting for picture…"
            this.detail.textContent = "We’ll reveal the stream on the next fresh game frame."
        }
    }

    /**
     * Verify browser visibility after the control channel is live. This does
     * not hold the host launcher: keyboard/mouse and touch players can always
     * continue while the game keeps opening behind this screen.
     */
    waitForController(): Promise<void> {
        this.controller.hidden = false
        this.controllerStatus.textContent = "Checking this browser for a controller…"

        return new Promise(resolve => {
            let finished = false
            let missingShown = false
            const finish = () => {
                if (finished) return
                finished = true
                clearInterval(poll)
                clearTimeout(missingTimer)
                window.removeEventListener("gamepadconnected", check)
                this.primary.onclick = null
                this.controllerCleanup = null
                resolve()
            }
            const useWithoutController = () => {
                this.controllerStatus.textContent = "Continuing with touch, keyboard or mouse"
                this.primary.hidden = true
                finish()
            }
            const check = () => {
                if (!visibleGamepad()) return
                this.controllerHelp.hidden = true
                missingShown = false
                this.controllerStatus.textContent = "Controller connected"
                this.primary.hidden = true
                finish()
            }
            const showMissing = () => {
                if (finished || visibleGamepad()) {
                    check()
                    return
                }
                missingShown = true
                this.controllerStatus.textContent = "No controller detected in this browser"
                this.controllerHelp.hidden = !isWindowsChrome()
                this.primary.textContent = isIOSWebKit()
                    ? "Continue with touch, keyboard or mouse"
                    : "Continue with keyboard & mouse"
                this.primary.hidden = false
                this.primary.onclick = useWithoutController
            }
            const poll = window.setInterval(() => {
                if (visibleGamepad()) check()
                else if (missingShown) this.controllerStatus.textContent = "No controller detected in this browser"
            }, 150)
            const missingTimer = window.setTimeout(showMissing, 1800)
            window.addEventListener("gamepadconnected", check)
            this.controllerCleanup = () => {
                clearInterval(poll)
                clearTimeout(missingTimer)
                window.removeEventListener("gamepadconnected", check)
                if (!finished) {
                    finished = true
                    resolve()
                }
            }
            check()
        })
    }

    /** Called only after this launch has both a running game and fresh video. */
    waitForSound(activate: () => Promise<void>): Promise<void> {
        this.status.textContent = "Your game is ready"
        this.detail.textContent = "Click, tap, or press Enter to enable sound and play."
        this.progress.hidden = true
        this.primary.textContent = "Enable sound and continue"
        this.primary.hidden = false
        return new Promise(resolve => {
            this.primary.onclick = () => {
                this.primary.disabled = true
                // Invoke before any await: Safari requires the real user gesture.
                const activation = activate()
                void activation.then(() => {
                    this.primary.onclick = null
                    this.primary.disabled = false
                    resolve()
                }, () => {
                    this.detail.textContent = "Sound could not start. Click or tap to try again."
                    this.primary.disabled = false
                })
            }
            this.primary.focus()
        })
    }

    showReconnect() {
        if (this.parent) this.mount(this.parent)
        this.root.classList.remove("pw-game-launch-failed")
        this.root.classList.add("pw-game-launch-reconnect")
        this.eyebrow.textContent = "Connection interrupted"
        this.status.textContent = "Reconnecting to your game…"
        this.detail.textContent = "The game is still running. We’re repairing the stream without replacing your controller."
        this.progress.hidden = false
        this.controller.hidden = true
        this.primary.hidden = true
        this.retry.hidden = true
        this.leave.textContent = "Back to library"
    }

    showClosing() {
        if (this.parent) this.mount(this.parent)
        this.controllerCleanup?.()
        this.root.classList.remove("pw-game-launch-failed", "pw-game-launch-reconnect")
        this.eyebrow.textContent = "Session complete"
        this.status.textContent = "Closing the game completely…"
        this.detail.textContent = "We’ll close this tab as soon as the computer is ready for another launch."
        this.progress.hidden = false
        this.controller.hidden = true
        this.primary.hidden = true
        this.retry.hidden = true
        this.leave.textContent = "Back to library"
    }

    fail(title: string, detail: string) {
        if (this.parent) this.mount(this.parent)
        this.controllerCleanup?.()
        this.root.classList.add("pw-game-launch-failed")
        this.root.classList.remove("pw-game-launch-reconnect")
        this.eyebrow.textContent = "Couldn’t start the game"
        this.status.textContent = title
        this.detail.textContent = detail
        this.progress.hidden = true
        this.controller.hidden = true
        this.primary.hidden = true
        this.retry.hidden = false
        this.leave.textContent = "Back to library"
    }

    end() {
        if (this.parent) this.mount(this.parent)
        this.controllerCleanup?.()
        this.root.classList.remove("pw-game-launch-failed", "pw-game-launch-reconnect")
        this.eyebrow.textContent = "Session complete"
        this.status.textContent = "Game closed"
        this.detail.textContent = "This browser could not close the stream tab automatically. You can return to your library."
        this.progress.hidden = true
        this.controller.hidden = true
        this.primary.hidden = true
        this.retry.hidden = true
        this.leave.textContent = "Back to library"
    }

    isVisible(): boolean {
        return !this.root.hidden
    }

    hide() {
        this.controllerCleanup?.()
        this.root.classList.remove("pw-game-launch-visible")
        window.setTimeout(() => {
            if (!this.root.classList.contains("pw-game-launch-visible")) {
                this.root.hidden = true
            }
        }, 280)
    }
}
