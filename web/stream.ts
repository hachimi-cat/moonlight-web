import "./polyfill/index"
import "./styles/index"
import { Api, PawpadoLaunchState, apiGetHost, apiGetPawpadoLaunchState, apiGetRole, apiHostCancel, getApi } from "./api"
import { Component } from "./component/index"
import { showNotification } from "./component/notification"
import { getModalBackground, showMessage, showModal } from "./component/modal/index"
import { getSidebarRoot, setSidebar, setSidebarExtended, setSidebarStyle, Sidebar } from "./component/sidebar/index"
import { defaultStreamInputConfig, MouseMode, ScreenKeyboardSetVisibleEvent, StreamInputConfig } from "./stream/input"
import { getLocalStreamSettings, Settings, TransportType } from "./component/settings_menu"
import { ShadcnSelectComponent as SelectComponent } from "./ui/shadcn-select"
import { emptyKeyModifiers } from "./stream/keyboard"
import { LogLevel, setLogger as uniffiSetLogger, Logger as UniffiLogger, uniffiInitAsync } from "./uniffi/entry"
import { DetailedRole, StreamKeys } from "./api_bindings"
import { KeyboardModeEvent, KeyboardModeWillChangeEvent, ScreenKeyboard, TextEvent } from "./screen_keyboard"
import { FormModal } from "./component/modal/form"
import { streamStatsToText } from "./stream/stats"
import { adoptRoleDefaultLanguage, getCurrentLanguage, getTranslations, Language, normalizeLanguage } from "./i18n"
import { requestKeyboardLock } from "./iframe"
import { InfoEvent, Stream, StreamCapabilities } from "./stream/index"
import { ConnectionInfoModal } from "./component/connection_info_modal"
import { wait } from "./util"
import { PawpadoLaunchOverlay, parsePawpadoGamePresentation } from "./component/pawpado_launch_overlay"
import { stopPropagationOn } from "./component/input_boundary"

let I = getTranslations(getCurrentLanguage())

function isIOSWebKit(): boolean {
    const ua = navigator.userAgent
    return /iPad|iPhone|iPod/i.test(ua) ||
        (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
}

async function startApp() {
    const uniffiInit = uniffiInitAsync()

    const queryParams = new URLSearchParams(location.search)
    const gamePresentation = parsePawpadoGamePresentation(queryParams)
    const launchOverlay = gamePresentation
        ? new PawpadoLaunchOverlay(gamePresentation)
        : null
    if (launchOverlay) {
        if (document.body) launchOverlay.mount(document.body)
        else document.addEventListener("DOMContentLoaded", () => launchOverlay.mount(document.body), { once: true })
    }

    const api = await getApi()
    // Snapshot the previous launch before this page asks Apollo to start
    // anything. The on-box state file survives between games; without this
    // baseline an immediate replay can mistake the previous run's `running`
    // or `exited` marker for the new one and uncover/abort the loading UI.
    const launchStateBaseline = launchOverlay
        ? await apiGetPawpadoLaunchState(api).catch(() => null)
        : null

    let lang = parseLanguageFromQuery(queryParams)
    const bootstrapRole = await apiGetRole(api, { id: null })
    if (!lang) {
        adoptRoleDefaultLanguage(bootstrapRole.role.default_settings)
        lang = getCurrentLanguage()
    }
    I = getTranslations(lang)

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showNotification(I.stream.rootNotFound, "error")
        return;
    }

    // Get Host and App via Query
    const hostIdStr = queryParams.get("hostId")
    const appIdStr = queryParams.get("appId")
    if (hostIdStr == null || appIdStr == null) {
        await showMessage(I.stream.missingHostOrApp)

        window.close()
        return
    }
    const hostId = Number.parseInt(hostIdStr)
    const appId = Number.parseInt(appIdStr)

    // event propagation on overlays
    const sidebarRoot = getSidebarRoot()
    if (sidebarRoot) {
        stopPropagationOn(sidebarRoot)
    }

    const modalBackground = getModalBackground()
    if (modalBackground) {
        stopPropagationOn(modalBackground)
    }

    // Wait for uniffi to finish it's initialization
    await uniffiInit

    // Set Uniffy Logger
    class CustomUniffiLogger implements UniffiLogger {
        log(level: LogLevel, message: string): void {
            switch (level) {
                case LogLevel.Trace:
                    console.trace(message)
                    break;
                case LogLevel.Debug:
                    console.debug(message)
                    break;
                case LogLevel.Warn:
                    console.warn(message)
                    break;
                case LogLevel.Info:
                    console.info(message)
                    break;
                case LogLevel.Error:
                    console.error(message)
                    break;
            }
        }
    }
    // Protocol debug logging includes every controller/mouse packet. Keep
    // the normal streaming hot path free of console/WASM log allocations.
    uniffiSetLogger(new CustomUniffiLogger(), LogLevel.Info)

    // Start and Mount App
    const app = new ViewerApp(api, hostId, appId, bootstrapRole.role, parseSettingsFromQuery(queryParams), launchOverlay, launchStateBaseline)
    app.mount(rootElement);

    (window as any)["app"] = app
}

// Prevent starting transition
window.requestAnimationFrame(() => {
    // Note: elements is a live array
    const elements = document.getElementsByClassName("prevent-start-transition")
    while (elements.length > 0) {
        elements.item(0)?.classList.remove("prevent-start-transition")
    }
})

function parseSettingsFromQuery(queryParams: URLSearchParams): Partial<Settings> {
    const settings: Partial<Settings> = {}

    const bitrate = queryParams.get("bitrate")
    if (bitrate) {
        settings.bitrate = Number(bitrate)
    }

    const fps = queryParams.get("fps")
    if (fps) {
        settings.fps = Number(fps)
    }

    const hdr = queryParams.get("hdr")
    if (hdr != null) {
        settings.hdr = hdr === "true"
    }

    const videoSize = queryParams.get("videoSize")
    if (videoSize) {
        settings.videoSize = videoSize as Settings["videoSize"]
    }

    const width = queryParams.get("videoSizeCustom.width")
    const height = queryParams.get("videoSizeCustom.height")
    if (width && height) {
        settings.videoSizeCustom = {
            width: Number(width),
            height: Number(height),
        }
    }

    const dataTransport = queryParams.get("dataTransport")
    if (dataTransport) {
        settings.dataTransport = dataTransport as TransportType
    }

    return settings
}

function parseLanguageFromQuery(queryParams: URLSearchParams): Language | undefined {
    const language = queryParams.get("language")
    return language ? normalizeLanguage(language) : undefined
}

startApp()

class ViewerApp implements Component {
    private api: Api
    private hostId: number
    private appId: number

    private sidebar: ViewerSidebar

    private div = document.createElement("div")

    private statsDiv = document.createElement("div")
    private localTouchCursorDiv = document.createElement("div")
    private stream: Stream

    private inputConfig: StreamInputConfig = defaultStreamInputConfig()
    private previousMouseMode: MouseMode

    private autoEnterFullscreenOnStart: boolean = false
    private pendingAutoFullscreenPrompt: boolean = false
    private fullscreenPromptShown: boolean = false
    private fullscreenOnNextInteractionArmed: boolean = false
    private pendingAutoFullscreenTouchGesture: boolean = false
    private pendingAutoFullscreenMouseGesture: boolean = false
    private manualFullscreenExitRequested: boolean = false

    private soundGateShown: boolean = false
    private pageExitHandled: boolean = false
    private directGameLaunchStarted: boolean = false
    private directGameLaunchReady: boolean = false
    private directGameLaunchFailure: string | null = null
    private reconnectOverlayRunning: boolean = false
    private launchOverlay: PawpadoLaunchOverlay | null
    private launchStateBaseline: PawpadoLaunchState | null
    private activeDirectLaunchId: string | null = null
    private gameExitWatchTimer: number | null = null
    private streamEnding = false

    // BioShock Infinite destroys its first window while entering exclusive
    // fullscreen and can leave desktop duplication without a complete frame
    // for roughly 9-11 seconds. The WebRTC watchdog deliberately waits 15
    // seconds before repairing that transition in place, so an 8-second
    // loading-screen deadline reported a false launch failure before the
    // recovery path was even allowed to run. Leave enough time for one
    // watchdog cycle and the repaired frame to arrive while the cover stays
    // over the desktop.
    private static readonly DIRECT_GAME_FRAME_TIMEOUT_MS = 35_000
    private static readonly RECONNECT_FRAME_TIMEOUT_MS = 20_000

    private toggleFullscreenWithKeybind: boolean = false

    private hasShownFullscreenEscapeWarning = false
    /** Pawpado game launches enter relative mouse mode on the first trusted
     * desktop click. Open Desktop intentionally omits the flag. */
    private pawpadoAutoPointerLock = new URLSearchParams(window.location.search)
        .get("pawpadoPointerLock") == "1"

    constructor(api: Api, hostId: number, appId: number, bootstrapRole: DetailedRole, options?: Partial<Settings>, launchOverlay: PawpadoLaunchOverlay | null = null, launchStateBaseline: PawpadoLaunchState | null = null) {
        this.api = api
        this.hostId = hostId
        this.appId = appId
        this.launchOverlay = launchOverlay
        this.launchStateBaseline = launchStateBaseline

        this.launchOverlay?.setCancelHandler(async () => {
            await this.cancelAndReturnToLibrary()
        })
        this.launchOverlay?.setRetryHandler(async () => {
            this.pageExitHandled = true
            try {
                await apiHostCancel(this.api, { host_id: this.hostId })
            } catch { }
            window.location.reload()
        })

        const defaultSettings = getLocalStreamSettings(bootstrapRole.default_settings)
        const settings = {
            ...defaultSettings,
            ...options,
            videoSizeCustom: {
                ...defaultSettings.videoSizeCustom,
                ...options?.videoSizeCustom,
            },
        }
        Object.assign(this.inputConfig, {
            mouseMode: settings.mouseMode,
            mouseScrollMode: settings.mouseScrollMode,
            scrollSensitivity: settings.scrollSensitivity,
            touchMode: settings.touchMode,
            localCursorSensitivity: settings.localCursorSensitivity,
            controllerConfig: settings.controllerConfig
        })

        // Configure sidebar
        this.sidebar = new ViewerSidebar(this)
        setSidebar(this.sidebar)

        // Configure stats element
        this.statsDiv.hidden = true
        this.statsDiv.classList.add("video-stats")
        this.localTouchCursorDiv.hidden = true
        this.localTouchCursorDiv.classList.add("local-touch-cursor")

        setInterval(() => {
            // Update stats display every 100ms
            const stats = this.getStream()?.getStats()
            if (stats && stats.isEnabled()) {
                this.statsDiv.hidden = false

                const text = streamStatsToText(stats.getCurrentStats())
                this.statsDiv.innerText = text
            } else {
                this.statsDiv.hidden = true
            }
        }, 100)
        this.div.appendChild(this.statsDiv)
        this.div.appendChild(this.localTouchCursorDiv)

        // Configure stream
        this.previousMouseMode = this.inputConfig.mouseMode

        const browserWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
        const browserHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0)

        this.autoEnterFullscreenOnStart = settings.enterFullscreenOnStreamStart
        this.toggleFullscreenWithKeybind = settings.toggleFullscreenWithKeybind

        // Apollo destroys and recreates its ViGEm device when a Moonlight
        // transport is replaced. Windows can assign the replacement to a
        // different XInput user slot, while a running game continues polling
        // the original slot. Pawpado controller launches therefore keep the
        // established transport: a true peer failure is surfaced to the
        // player instead of silently reconnecting with a different gamepad.
        const preserveControllerSession = new URLSearchParams(window.location.search).get("pawpadoController") == "1"
        this.stream = new Stream(this.api, hostId, appId, settings, [browserWidth, browserHeight], bootstrapRole.permissions, preserveControllerSession)
        this.startStream(settings)

        // Configure input
        this.addListeners(document)
        this.addListeners(document.getElementById("input") as HTMLDivElement)

        window.addEventListener("blur", () => {
            this.stream.getInput().raiseAllKeys()
        })
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") {
                this.stream.getInput().raiseAllKeys()
            }
        })

        // A Pawpado stream tab owns the app it launched. Cancel the host app
        // when the tab closes so a later launch cannot resume stale state or
        // resolution. Do not also close the individual WebRTC transport:
        // host cancellation already tears it down, and two overlapping
        // teardown requests can trip Apollo's 10-second termination assert.
        // `pagehide` covers tab close/mobile navigation; `beforeunload` is a
        // desktop fallback. The request uses keepalive because unload
        // handlers cannot be awaited by the browser.
        const stopOnPageExit = () => {
            this.stopGameExitWatch()
            if (this.pageExitHandled) return
            this.pageExitHandled = true

            void apiHostCancel(
                this.api,
                { host_id: this.hostId },
                { keepalive: true },
            ).catch(() => { })
        }
        window.addEventListener("pagehide", stopOnPageExit)
        window.addEventListener("beforeunload", stopOnPageExit)

        document.addEventListener("pointerlockchange", this.onPointerLockChange.bind(this))
        document.addEventListener("fullscreenchange", this.onFullscreenChange.bind(this))
        document.addEventListener("webkitfullscreenchange", this.onFullscreenChange.bind(this))

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        // Connect all gamepads
        for (const gamepad of navigator.getGamepads()) {
            if (gamepad != null) {
                this.onGamepadAdd(gamepad)
            }
        }
    }
    private addListeners(element: GlobalEventHandlers) {
        element.addEventListener("keydown", this.onKeyDown.bind(this), { passive: false })
        element.addEventListener("keyup", this.onKeyUp.bind(this), { passive: false })
        element.addEventListener("paste", this.onPaste.bind(this))

        element.addEventListener("mousedown", this.onMouseButtonDown.bind(this), { passive: false })
        element.addEventListener("mouseup", this.onMouseButtonUp.bind(this), { passive: false })
        element.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false })
        element.addEventListener("wheel", this.onMouseWheel.bind(this), { passive: false })
        element.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })

        element.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: false })
        element.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: false })
        element.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: false })
        element.addEventListener("touchmove", this.onTouchMove.bind(this), { passive: false })
    }

    private async startStream(settings: Settings) {
        setSidebarStyle({
            edge: settings.sidebarEdge,
        })

        // Optionally keep the sidebar toggle invisible until hovered/focused
        document.getElementById("sidebar-button")
            ?.classList.toggle("sidebar-button-unobtrusive", settings.hideSidebarButton)

        // Add app info listener
        this.stream.addInfoListener(this.onInfo.bind(this))

        // Direct game links own a full-screen, game-specific progress surface.
        // Desktop/system links keep Moonlight's ordinary connection modal.
        if (this.launchOverlay) {
            this.launchOverlay.mount(document.body)
        } else {
            const connectionInfo = new ConnectionInfoModal()
            const connectionInfoListener = connectionInfo.onInfo.bind(connectionInfo)
            this.stream.addInfoListener(connectionInfoListener)
            showModal(connectionInfo)
        }

        // Start animation frame loop
        this.onTouchUpdate()
        this.onGamepadUpdate()

        this.stream.getInput().addScreenKeyboardVisibleEvent(this.onScreenKeyboardSetVisible.bind(this))

        this.stream.mount(this.div)

        if (this.autoEnterFullscreenOnStart) {
            this.pendingAutoFullscreenPrompt = true
        }
    }

    private async onInfo(event: InfoEvent) {
        const data = event.detail
        // Pending ICE/frame callbacks cannot reopen or overwrite the closing UI.
        if (this.streamEnding) return
        if (this.directGameLaunchFailure && data.type != "streamEnded") return

        if (data.type == "app") {
            const appName = data.appName

            document.title = `Stream: ${appName}`
        } else if (data.type == "addDebugLine" && this.launchOverlay) {
            const line = data.line.trim()
            if (data.additional?.type == "fatal" || data.additional?.type == "fatalDescription") {
                this.launchOverlay.fail("Connection failed", this.readableStreamError(line))
            } else if (data.additional?.type == "informError") {
                showNotification(line, "error")
            } else if (
                data.additional?.type == "recover" ||
                /media .*reconnecting|falling back to web socket/i.test(line)
            ) {
                if (/completed|connected successfully/i.test(line)) {
                    void this.finishReconnectOverlay()
                } else if (/restart|reconnect|falling back/i.test(line)) {
                    if (this.directGameLaunchReady) this.launchOverlay.showReconnect()
                }
            }
        } else if (data.type == "connectionComplete") {
            this.sidebar.onCapabilitiesChange(data.capabilities)

            this.armFullscreenOnNextInteraction()
            if (this.launchOverlay) {
                if (!this.directGameLaunchStarted) {
                    this.directGameLaunchStarted = true
                    void this.finishDirectGameLaunch()
                } else {
                    void this.finishReconnectOverlay()
                }
            } else {
                this.showIOSSoundGate()
            }
        } else if (data.type == "streamEnded") {
            this.streamEnding = true
            this.stopGameExitWatch()
            // Apollo tears down media when a launcher exits unsuccessfully,
            // too. Its transport packet is not the cause of that failure.
            await this.readDirectGameLaunchFailure()
            if (data.graceful && !this.directGameLaunchFailure) this.launchOverlay?.showClosing()
            // Quit-the-game closes the tab, but ONLY when the embedder asked
            // for it (?autoclose=1). A ServerTermination packet is the best
            // signal, but Apollo does not send one on every app-exit path. If
            // it is absent, confirm that the host is still reachable and no
            // longer reports this app as current before closing. A dropped
            // connection must leave the tab open so it can explain the loss.
            const autoClose = !this.directGameLaunchFailure && await this.shouldAutoClose(data.graceful)
            // The host app/transport is already gone. Suppress the pagehide
            // cancel generated by our own auto-close (or by a later manual
            // close after the end message); it is both redundant and unsafe
            // while Apollo is still unwinding the first teardown.
            if (data.graceful || autoClose) {
                this.pageExitHandled = true
            }
            if (autoClose) {
                if (window.matchMedia('(display-mode: standalone)').matches) {
                    history.back()
                } else {
                    window.close()
                }
            }
            if (this.launchOverlay) {
                if (this.directGameLaunchFailure) {
                    this.showDirectGameLaunchFailure()
                } else if (data.graceful || autoClose) {
                    this.launchOverlay.end()
                } else {
                    this.launchOverlay.fail(
                        "Connection to the machine was lost",
                        "The game may still be running. Try reopening it from your library.",
                    )
                }
                return
            }
            // Reached when we didn't close — including a window.close() the
            // browser refused. Without this the player is left staring at
            // the frozen last frame.
            await showMessage(data.graceful ? I.stream.streamEnded : I.stream.connectionLost)
        }
    }

    private readableStreamError(line: string): string {
        if (!line || /candidate:|ice candidate/i.test(line)) {
            return "The secure stream could not be established. Try again from your library."
        }
        return line.length > 240 ? `${line.slice(0, 237)}…` : line
    }

    private async readDirectGameLaunchFailure() {
        if (!this.launchOverlay || this.directGameLaunchFailure) return
        try {
            const state = await apiGetPawpadoLaunchState(this.api)
            if (this.belongsToActiveLaunch(state) && state?.state == "failed") {
                this.directGameLaunchFailure = state.message || "The game process could not be started."
            }
        } catch {
            // An unreachable status endpoint is not evidence of a game crash.
        }
    }

    private showDirectGameLaunchFailure() {
        if (this.launchOverlay && this.directGameLaunchFailure) {
            this.launchOverlay.fail(`Couldn’t open ${this.launchOverlay.game.title}`, this.directGameLaunchFailure)
        }
    }

    private async waitForMatchingGameProcess(): Promise<void> {
        if (!this.launchOverlay) return
        // The host now waits for a real top-level game window rather than
        // declaring success at process spawn. Leave enough room for that
        // 180-second window wait, controller (25s), bounded startup-file
        // preparation (8s), previous-process cleanup (12s), and API margin.
        const deadline = Date.now() + 240_000
        let sawState = false
        while (Date.now() < deadline) {
            if (this.streamEnding || this.pageExitHandled) throw new Error("Game launch was canceled.")
            let terminalError: Error | null = null
            try {
                const state = await apiGetPawpadoLaunchState(this.api)
                if (this.streamEnding || this.pageExitHandled) return
                if (state && this.belongsToActiveLaunch(state)) {
                    sawState = true
                    if (state.launchId) this.activeDirectLaunchId = state.launchId
                    if (state.state == "failed") {
                        terminalError = new Error(state.message || "The game process could not be started.")
                    }
                    if (state.state == "exited") {
                        terminalError = new Error("The game closed before its first picture was ready.")
                    }
                    if (state.state == "preparing" || state.state == "starting" || state.state == "running") {
                        this.launchOverlay.setLaunchState(state.state, state.message)
                    }
                    if (state.state == "running") {
                        this.startGameExitWatch()
                        return
                    }
                }
            } catch {
                // The status file may not exist during the launcher's first
                // few milliseconds. Keep the secure stream covered and poll.
            }
            if (terminalError) throw terminalError
            await wait(350)
        }
        throw new Error(sawState
            ? `${this.launchOverlay.game.title} did not finish opening in time.`
            : "The computer did not report game launch progress in time.")
    }

    private isFreshLaunchState(state: PawpadoLaunchState): boolean {
        if (!this.launchStateBaseline) return true
        if (state.launchId && this.launchStateBaseline.launchId) {
            return state.launchId != this.launchStateBaseline.launchId
        }
        return state.updatedAt > this.launchStateBaseline.updatedAt
    }

    private belongsToActiveLaunch(state: PawpadoLaunchState | null): boolean {
        return state != null && state.slug == this.launchOverlay?.game.slug &&
            (this.activeDirectLaunchId != null
                ? state.launchId == this.activeDirectLaunchId
                : this.isFreshLaunchState(state))
    }

    private startGameExitWatch() {
        if (this.gameExitWatchTimer != null || this.streamEnding || this.pageExitHandled) return
        // Observe the lightweight launcher record during play, not just after
        // transport failure. Apollo may finish process/display cleanup after
        // media ends, and its termination packet can be lost in that interval.
        this.gameExitWatchTimer = window.setTimeout(async () => {
            try {
                const state = await apiGetPawpadoLaunchState(this.api)
                if (!this.streamEnding && !this.pageExitHandled &&
                    this.belongsToActiveLaunch(state) && state?.state == "exited") {
                    this.stream.notifyGameExited()
                }
            } catch {
                // An unreachable host is NOT evidence of a normal game exit.
            } finally {
                this.gameExitWatchTimer = null
                this.startGameExitWatch()
            }
        }, 1000)
    }

    private stopGameExitWatch() {
        if (this.gameExitWatchTimer != null) window.clearTimeout(this.gameExitWatchTimer)
        this.gameExitWatchTimer = null
    }

    private async waitForFreshVideoFrame(timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs
        let video: HTMLVideoElement | null = null
        while (Date.now() < deadline) {
            video = document.querySelector("video.video-stream")
            if (video) break
            const canvas = document.querySelector("canvas.video-stream") as HTMLCanvasElement | null
            if (canvas?.width && canvas.height) {
                // Canvas pipelines do not expose requestVideoFrameCallback.
                // Keep the cover up for several presentation intervals after
                // the process marker rather than revealing the desktop frame.
                await wait(700)
                return
            }
            await wait(80)
        }
        if (!video) throw new Error("The game opened, but no video frame arrived.")

        const frameVideo = video as HTMLVideoElement & {
            requestVideoFrameCallback?: (callback: () => void) => number
            cancelVideoFrameCallback?: (id: number) => void
        }
        if (!frameVideo.requestVideoFrameCallback) {
            await wait(700)
            return
        }
        await new Promise<void>((resolve, reject) => {
            const callbackId = frameVideo.requestVideoFrameCallback!(() => {
                clearTimeout(timeout)
                resolve()
            })
            const timeout = window.setTimeout(() => {
                frameVideo.cancelVideoFrameCallback?.(callbackId)
                reject(new Error("The game opened, but its picture stopped updating."))
            }, Math.max(1, deadline - Date.now()))
        })
    }

    private async finishDirectGameLaunch() {
        if (!this.launchOverlay) return
        const controllerReady = this.launchOverlay.waitForController()
        try {
            await this.waitForMatchingGameProcess()
            if (this.streamEnding || this.pageExitHandled) return
            await this.waitForFreshVideoFrame(ViewerApp.DIRECT_GAME_FRAME_TIMEOUT_MS)
            await controllerReady
            if (this.streamEnding || this.pageExitHandled) return
            if (isIOSWebKit()) await this.launchOverlay.waitForSound(() => this.activateReadyMedia())
            if (this.streamEnding || this.pageExitHandled) return
            this.directGameLaunchReady = true
            this.launchOverlay.hide()
        } catch (error) {
            if (this.streamEnding || this.pageExitHandled) return
            this.directGameLaunchFailure = error instanceof Error ? error.message : "The game did not finish opening."
            this.showDirectGameLaunchFailure()
        }
    }

    private async finishReconnectOverlay() {
        if (!this.launchOverlay || !this.directGameLaunchReady || this.directGameLaunchFailure || this.streamEnding || this.pageExitHandled || this.reconnectOverlayRunning || !this.launchOverlay.isVisible()) return
        this.reconnectOverlayRunning = true
        try {
            await this.waitForFreshVideoFrame(ViewerApp.RECONNECT_FRAME_TIMEOUT_MS)
            if (this.streamEnding || this.pageExitHandled) return
            if (isIOSWebKit()) await this.launchOverlay.waitForSound(() => this.activateReadyMedia())
            if (this.streamEnding || this.pageExitHandled) return
            this.launchOverlay.hide()
        } catch (error) {
            if (this.streamEnding || this.pageExitHandled) return
            this.launchOverlay.fail(
                "The stream could not recover",
                error instanceof Error ? error.message : "No fresh game picture arrived.",
            )
        } finally {
            this.reconnectOverlayRunning = false
        }
    }

    private cancelAndReturnToLibrary() {
        this.pageExitHandled = true
        this.stopGameExitWatch()
        // Navigation cannot wait up to the API's 12-second timeout: doing so
        // loses the trusted click needed by window.close() and made the button
        // appear dead during a broken stream. Dispatch cleanup with unload
        // semantics; the overlay's native link owns the actual navigation.
        void apiHostCancel(
            this.api,
            { host_id: this.hostId },
            { keepalive: true },
        ).catch(() => { })
    }

    private async shouldAutoClose(graceful: boolean): Promise<boolean> {
        const requested = new URLSearchParams(window.location.search).get("autoclose") == "1"
        if (!requested) {
            return false
        }
        // Apollo's app undo hook can emit a graceful termination packet
        // before Windows display/process cleanup has finished. Closing the
        // tab on that packet made an immediate replay race the old app and
        // strand a headless game process. Treat graceful as intent, not proof:
        // require this launch's terminal marker AND Apollo's paired host view
        // to report that the app slot is actually free.
        const deadline = Date.now() + (graceful ? 45_000 : 8_000)
        let launchExited = this.launchOverlay == null
        while (Date.now() < deadline) {
            if (this.launchOverlay) {
                try {
                    const state = await apiGetPawpadoLaunchState(this.api)
                    if (state && this.belongsToActiveLaunch(state)) {
                        if (state.state == "failed") {
                            this.directGameLaunchFailure = state.message || "The game process could not be started."
                            return false
                        }
                        if (state.state == "preparing" || state.state == "starting" || state.state == "running") {
                            // A delayed packet from an older teardown must
                            // never close a newly-started game tab.
                            return false
                        }
                        if (state.state == "exited") {
                            launchExited = true
                            this.launchOverlay.showClosing()
                        }
                    }
                } catch {
                    // Keep waiting. A transient state-file/API miss while the
                    // host unwinds is not permission to close the page.
                }
            }

            if (launchExited) {
                try {
                    const host = await apiGetHost(this.api, { host_id: this.hostId }, 2500)
                    if (host.server_state != null && host.current_game != this.appId) return true
                } catch {
                    // Apollo's server-info request can time out while its
                    // synchronous display cleanup is running. Retry until the
                    // bounded teardown window expires.
                }
            }
            await wait(500)
        }

        return false
    }

    private focusInput() {
        if (this.stream.getInput().getCurrentPredictedTouchAction() != "screenKeyboard" && !this.sidebar.getScreenKeyboard().isVisible()) {
            const inputElement = document.getElementById("input") as HTMLDivElement
            inputElement.focus()
        }
    }

    onUserInteraction() {
        this.focusInput()

        this.stream.getVideoRenderer()?.onUserInteraction()
        void Promise.resolve(this.stream.getAudioPlayer()?.onUserInteraction()).catch(() => { })
    }

    private activateReadyMedia(): Promise<void> {
        try {
            this.stream.getVideoRenderer()?.onUserInteraction()
            const player = this.stream.getAudioPlayer()
            if (!player) return Promise.reject(new Error("Audio is not ready"))
            const activation = player.onUserInteraction()
            // Start both operations within this same trusted click/tap/Enter.
            this.consumeAutoFullscreenInteraction()
            return Promise.resolve(activation)
        } catch (error) {
            return Promise.reject(error)
        }
    }

    /**
     * iOS does not treat a hardware gamepad button as an autoplay gesture.
     * Our Safari audio pipeline consequently remains suspended (and drops
     * PCM before its first interaction) when somebody plays controller-only.
     * Ask for one explicit tap after the audio player exists, then resume it
     * synchronously inside that gesture.
     */
    private showIOSSoundGate() {
        if (!isIOSWebKit() || this.soundGateShown || !document.body) return
        this.soundGateShown = true

        const overlay = document.createElement("section")
        overlay.setAttribute("role", "dialog")
        overlay.setAttribute("aria-modal", "true")
        overlay.setAttribute("aria-labelledby", "sound-gate-title")
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;box-sizing:border-box;padding:24px;background:rgba(16,13,12,.96);color:#f7f3ef;font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;touch-action:manipulation"

        const button = document.createElement("button")
        button.type = "button"
        button.style.cssText = "width:min(420px,100%);box-sizing:border-box;border:1px solid rgba(255,255,255,.16);border-radius:18px;background:#1b1614;color:#f7f3ef;padding:28px 24px;box-shadow:0 24px 80px rgba(0,0,0,.55);font:inherit;text-align:center;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent"
        button.innerHTML = "<strong id=\"sound-gate-title\" style=\"display:block;font-size:22px;line-height:1.25\">Play with sound</strong><span style=\"display:block;margin-top:9px;color:#c9bdb4\">Click, tap, or press Enter to enable game audio.</span>"
        overlay.appendChild(button)

        let finished = false
        const enter = (event: Event) => {
            event.preventDefault()
            event.stopPropagation()
            if (finished) return
            finished = true
            // Keep this synchronous: Safari only permits play()/resume()
            // while the tap's transient activation is still live.
            void this.activateReadyMedia().then(() => overlay.remove(), () => {
                finished = false
                button.textContent = "Sound could not start. Click or tap to try again."
            })
        }
        // ViewerApp owns document-level touch handlers that intentionally
        // prevent synthetic clicks. Consume the real touch here instead.
        stopPropagationOn(overlay)
        button.addEventListener("click", enter)
        document.body.appendChild(overlay)
        button.focus()
    }

    // -- Auto Fullscreen
    private armFullscreenOnNextInteraction() {
        // iPhone Safari exposes neither page-fullscreen entry point. Arming
        // anyway consumed the tap before onUserInteraction could unlock
        // Web Audio, showed the unsupported warning, then re-armed forever.
        // Manual fullscreen can still explain the Home Screen alternative;
        // the automatic path must never steal input it cannot use.
        const target = (document.body ?? document.documentElement) as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void> | void
        }
        const canRequest = Boolean(target) &&
            (typeof target.requestFullscreen == "function" ||
                typeof target.webkitRequestFullscreen == "function")
        if (this.autoEnterFullscreenOnStart && canRequest) {
            this.fullscreenOnNextInteractionArmed = true
        } else {
            this.fullscreenOnNextInteractionArmed = false
        }
    }
    private consumeAutoFullscreenInteraction(): boolean {
        if (!this.fullscreenOnNextInteractionArmed || this.isFullscreen()) {
            return false
        }

        this.fullscreenOnNextInteractionArmed = false
        void this.requestFullscreen().then(() => {
            if (!this.isFullscreen()) {
                this.armFullscreenOnNextInteraction()
            }
        })
        return true
    }
    private beginAutoFullscreenTouchGesture(): boolean {
        if (!this.fullscreenOnNextInteractionArmed || this.isFullscreen()) {
            return false
        }

        this.pendingAutoFullscreenTouchGesture = true
        return true
    }
    private consumeAutoFullscreenTouchGesture(): boolean {
        if (!this.pendingAutoFullscreenTouchGesture) {
            return false
        }

        this.pendingAutoFullscreenTouchGesture = false
        return this.consumeAutoFullscreenInteraction()
    }

    private onScreenKeyboardSetVisible(event: ScreenKeyboardSetVisibleEvent) {
        console.info(event.detail)
        const screenKeyboard = this.sidebar.getScreenKeyboard()

        const newShown = event.detail.visible
        if (newShown != screenKeyboard.isVisible()) {
            if (newShown) {
                screenKeyboard.show()
            } else {
                screenKeyboard.hide()
            }
        }
    }

    // Input
    getInputConfig(): StreamInputConfig {
        return this.inputConfig
    }
    setInputConfig(config: StreamInputConfig) {
        Object.assign(this.inputConfig, config)

        this.stream.getInput().setConfig(this.inputConfig)
        this.renderLocalTouchCursor()
    }

    // Keyboard
    onKeyDown(event: KeyboardEvent) {
        this.onUserInteraction()

        if (event.shiftKey && event.ctrlKey && event.code == "KeyV") {
            // We are likely pasting -> don't send keys
        } else if (event.code == "F11") {
            // Allow manual fullscreen
        } else {
            event.preventDefault()
            this.stream.getInput().onKeyDown(event)
        }

        event.stopPropagation()
    }

    private isTogglingFullscreenWithKeybind: "waitForCtrl" | "makingFullscreen" | "none" = "none"
    onKeyUp(event: KeyboardEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onKeyUp(event)
        event.stopPropagation()

        if (this.toggleFullscreenWithKeybind && this.isTogglingFullscreenWithKeybind == "none" && event.ctrlKey && event.shiftKey && event.code == "KeyI") {
            this.isTogglingFullscreenWithKeybind = "waitForCtrl"
        }
        if (this.isTogglingFullscreenWithKeybind == "waitForCtrl" && (event.code == "ControlRight" || event.code == "ControlLeft")) {
            this.isTogglingFullscreenWithKeybind = "makingFullscreen";

            (async () => {
                if (this.isFullscreen()) {
                    await this.exitPointerLock()
                    await this.exitFullscreen()
                } else {
                    await this.requestFullscreen()
                    await this.requestPointerLock()
                }

                this.isTogglingFullscreenWithKeybind = "none"
            })()
        }
    }

    onPaste(event: ClipboardEvent) {
        this.onUserInteraction()

        this.stream.getInput().onPaste(event)

        event.stopPropagation()
    }

    // Mouse
    onMouseButtonDown(event: MouseEvent) {
        this.onUserInteraction()
        if (this.consumeAutoFullscreenInteraction()) {
            this.pendingAutoFullscreenMouseGesture = true
            event.preventDefault()
            event.stopPropagation()
            return
        }

        const pointerLockSupported = typeof document.getElementById("input")?.requestPointerLock == "function"
        if (this.pawpadoAutoPointerLock && pointerLockSupported && !document.pointerLockElement) {
            event.preventDefault()
            event.stopPropagation()
            void this.requestPointerLock(true).catch(error => {
                this.pawpadoAutoPointerLock = false
                this.inputConfig.mouseMode = this.previousMouseMode
                this.setInputConfig(this.inputConfig)
                console.warn("failed to enter Pawpado pointer lock", error)
            })
            return
        }

        event.preventDefault()
        this.stream.getInput().onMouseDown(event, this.getStreamRect());

        event.stopPropagation()
    }
    onMouseButtonUp(event: MouseEvent) {
        if (this.pendingAutoFullscreenMouseGesture) {
            this.pendingAutoFullscreenMouseGesture = false
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onMouseUp(event)

        event.stopPropagation()
    }
    onMouseMove(event: MouseEvent) {
        if (this.pendingAutoFullscreenMouseGesture) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        event.preventDefault()
        this.stream.getInput().onMouseMove(event, this.getStreamRect())

        event.stopPropagation()
    }
    onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseWheel(event, this.getStreamRect())

        event.stopPropagation()
    }
    onContextMenu(event: MouseEvent) {
        event.preventDefault()

        event.stopPropagation()
    }

    // Touch
    onTouchStart(event: TouchEvent) {
        if (this.beginAutoFullscreenTouchGesture()) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onTouchStart(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchEnd(event: TouchEvent) {
        this.onUserInteraction()
        if (this.consumeAutoFullscreenTouchGesture()) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        event.preventDefault()
        this.stream.getInput().onTouchEnd(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchCancel(event: TouchEvent) {
        if (this.pendingAutoFullscreenTouchGesture) {
            this.pendingAutoFullscreenTouchGesture = false
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.pendingAutoFullscreenTouchGesture = false

        this.onUserInteraction()

        event?.preventDefault()
        this.stream.getInput().onTouchCancel(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchUpdate() {
        this.stream.getInput().onTouchUpdate(this.getStreamRect())
        this.updateKeyboardViewportVideoOffset()
        this.renderLocalTouchCursor()

        window.requestAnimationFrame(this.onTouchUpdate.bind(this))
    }
    onTouchMove(event: TouchEvent) {
        if (this.pendingAutoFullscreenTouchGesture) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        event.preventDefault()
        this.stream.getInput().onTouchMove(event, this.getStreamRect())

        event.stopPropagation()
    }

    // Gamepad
    onGamepadConnect(event: GamepadEvent) {
        this.onGamepadAdd(event.gamepad)
    }
    onGamepadAdd(gamepad: Gamepad) {
        this.stream.getInput().onGamepadConnect(gamepad)
    }
    onGamepadDisconnect(event: GamepadEvent) {
        this.stream.getInput().onGamepadDisconnect(event)
    }
    onGamepadUpdate() {
        this.stream.getInput().onGamepadUpdate()

        window.requestAnimationFrame(this.onGamepadUpdate.bind(this))
    }

    // Fullscreen
    async requestFullscreen(showEscapeWarning: boolean = true) {
        const target = (document.body ?? document.documentElement) as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void> | void
        }
        if (target) {
            const standardRequest = typeof target.requestFullscreen == "function"
                ? target.requestFullscreen.bind(target)
                : null
            const webkitRequest = typeof target.webkitRequestFullscreen == "function"
                ? target.webkitRequestFullscreen.bind(target)
                : null
            if (!standardRequest && !webkitRequest) {
                await showMessage(I.stream.fullscreenUnsupported)

                return
            }

            this.focusInput()

            if (!this.isFullscreen()) {
                try {
                    if (standardRequest) {
                        await standardRequest({ navigationUI: "hide" })
                    } else {
                        await webkitRequest!()
                    }
                } catch (e) {
                    console.warn("failed to request fullscreen", e)
                }
            }

            try {
                await requestKeyboardLock();
                if (showEscapeWarning && !this.hasShownFullscreenEscapeWarning) {
                    showNotification(I.stream.fullscreenEscapeHint, "info")
                    this.hasShownFullscreenEscapeWarning = true
                }
            } catch (e) {
                console.warn("Keyboard lock failed, skipping notification.", e);
            }

            if (this.pawpadoAutoPointerLock || this.getStream()?.getInput().getConfig().mouseMode == "relative") {
                await this.requestPointerLock()
            }

            try {
                if (screen && "orientation" in screen) {
                    const orientation = screen.orientation

                    if ("lock" in orientation && typeof orientation.lock == "function") {
                        await orientation.lock("landscape")
                    }
                }
            } catch (e) {
                console.warn("failed to set orientation to landscape", e)
            }
        } else {
            console.warn("root element not found")
        }
    }
    async exitFullscreen() {
        if ("keyboard" in navigator && navigator.keyboard && "unlock" in navigator.keyboard) {
            await navigator.keyboard.unlock()
        }

        const webkitDocument = document as Document & {
            webkitExitFullscreen?: () => Promise<void> | void
        }
        if (typeof document.exitFullscreen == "function") {
            await document.exitFullscreen()
        } else if (typeof webkitDocument.webkitExitFullscreen == "function") {
            await webkitDocument.webkitExitFullscreen()
        }
    }
    isFullscreen(): boolean {
        const webkitDocument = document as Document & {
            webkitFullscreenElement?: Element | null
        }
        return !!(document.fullscreenElement ?? webkitDocument.webkitFullscreenElement)
    }
    private async onFullscreenChange() {
        if (this.isFullscreen()) {
            this.fullscreenOnNextInteractionArmed = false
            this.pendingAutoFullscreenTouchGesture = false
            this.pendingAutoFullscreenMouseGesture = false
            this.manualFullscreenExitRequested = false
        } else {
            const manualExit = this.manualFullscreenExitRequested
            this.manualFullscreenExitRequested = false

            if (this.autoEnterFullscreenOnStart && !manualExit) {
                this.armFullscreenOnNextInteraction()
            }
        }

        this.checkFullyImmersed()
    }
    markManualFullscreenExitRequested() {
        this.manualFullscreenExitRequested = true
    }

    // Pointer Lock
    async requestPointerLock(errorIfNotFound: boolean = false) {
        this.previousMouseMode = this.inputConfig.mouseMode

        const inputElement = document.getElementById("input") as HTMLDivElement

        if (inputElement && "requestPointerLock" in inputElement && typeof inputElement.requestPointerLock == "function") {
            this.focusInput()

            this.inputConfig.mouseMode = "relative"
            this.setInputConfig(this.inputConfig)

            setSidebarExtended(false)

            const onLockError = () => {
                document.removeEventListener("pointerlockerror", onLockError)

                // Fallback: try to request pointer lock without options
                inputElement.requestPointerLock()
            }

            document.addEventListener("pointerlockerror", onLockError, { once: true })

            try {
                let promise = inputElement.requestPointerLock({
                    unadjustedMovement: true
                })

                if (promise) {
                    await promise
                } else {
                    inputElement.requestPointerLock()
                }
            } catch (error) {
                // Some platforms do not support unadjusted movement. If you
                // would like PointerLock anyway, request again.
                if (error instanceof Error && error.name == "NotSupportedError") {
                    inputElement.requestPointerLock()
                } else {
                    throw error
                }
            } finally {
                document.removeEventListener("pointerlockerror", onLockError)
            }

        } else if (errorIfNotFound) {
            await showMessage(I.stream.pointerLockUnsupported)
        }
    }
    async exitPointerLock() {
        if ("exitPointerLock" in document && typeof document.exitPointerLock == "function") {
            document.exitPointerLock()
        }
    }
    private onPointerLockChange() {
        this.checkFullyImmersed()

        if (!document.pointerLockElement) {
            this.inputConfig.mouseMode = this.previousMouseMode
            this.setInputConfig(this.inputConfig)
        }
    }

    // -- Fully immersed Fullscreen -> Fullscreen API + Pointer Lock
    private checkFullyImmersed() {
        if ("pointerLockElement" in document && document.pointerLockElement && this.isFullscreen()) {
            // We're fully immersed -> remove sidebar
            setSidebar(null)
        } else {
            setSidebar(this.sidebar)
        }
    }

    private renderLocalTouchCursor() {
        const localCursorState = this.stream.getInput().getLocalCursorState()
        if (!localCursorState?.visible) {
            this.localTouchCursorDiv.hidden = true
            return
        }

        const rect = this.getStreamRect()
        if (rect.width <= 0 || rect.height <= 0) {
            this.localTouchCursorDiv.hidden = true
            return
        }

        this.localTouchCursorDiv.hidden = false
        this.localTouchCursorDiv.style.left = `${rect.left + localCursorState.x * rect.width}px`
        this.localTouchCursorDiv.style.top = `${rect.top + localCursorState.y * rect.height}px`
    }

    // -- Keyboard Mode
    private keyboardViewportBaselineHeight: number | null = null
    private streamVideoTopOffsetPx: number = 0

    onScreenKeyboardModeWillChange(event: KeyboardModeWillChangeEvent) {
        if (event.detail.enabled) {
            this.captureKeyboardViewportBaseline()
        }
    }

    private captureKeyboardViewportBaseline() {
        this.keyboardViewportBaselineHeight = window.visualViewport?.height ?? null
        this.streamVideoTopOffsetPx = 0
        this.applyStreamVideoTopOffset()
        this.updateKeyboardFloatingButtonPosition()
    }
    resetKeyboardViewportVideoOffset() {
        this.keyboardViewportBaselineHeight = null
        this.streamVideoTopOffsetPx = 0
        this.applyStreamVideoTopOffset()
        this.resetKeyboardFloatingButtonPosition()
    }
    private updateKeyboardViewportVideoOffset() {
        this.updateKeyboardFloatingButtonPosition()

        const screenKeyboard = this.sidebar.getScreenKeyboard()
        const visualViewport = window.visualViewport
        const baselineHeight = this.keyboardViewportBaselineHeight
        const localCursorState = this.stream.getInput().getLocalCursorState()

        if (!screenKeyboard.isVisible() || !visualViewport || baselineHeight == null) {
            if (this.streamVideoTopOffsetPx != 0 && !screenKeyboard.isVisible()) {
                this.resetKeyboardViewportVideoOffset()
            }
            return
        }

        const viewportShrink = baselineHeight - visualViewport.height
        if (viewportShrink < 80) {
            if (this.streamVideoTopOffsetPx != 0) {
                this.streamVideoTopOffsetPx = 0
                this.applyStreamVideoTopOffset()
            }
            return
        }

        const streamRect = this.getStreamRect()
        if (streamRect.width <= 0 || streamRect.height <= 0) {
            return
        }

        const visibleTop = visualViewport.offsetTop
        const visibleBottom = visualViewport.offsetTop + visualViewport.height

        let newTopOffsetPx = this.streamVideoTopOffsetPx
        if (localCursorState.visible) {
            let delta = 0

            const safeMargin = Math.min(100, visualViewport.height * 0.25)
            const cursorY = streamRect.top + localCursorState.y * streamRect.height

            if (cursorY < visibleTop + safeMargin) {
                delta = visibleTop + safeMargin - cursorY
            } else if (cursorY > visibleBottom - safeMargin) {
                delta = visibleBottom - safeMargin - cursorY
            }

            newTopOffsetPx += delta
        } else {
            const screenTopToVideoTop = visualViewport.height - streamRect.height
            if (screenTopToVideoTop > 0) {
                newTopOffsetPx = visibleTop - screenTopToVideoTop
            }
        }

        if (Math.abs(newTopOffsetPx - this.streamVideoTopOffsetPx) >= 1) {
            this.streamVideoTopOffsetPx = newTopOffsetPx
            this.applyStreamVideoTopOffset()
        }
    }
    private applyStreamVideoTopOffset() {
        if (Math.abs(this.streamVideoTopOffsetPx) < 0.5) {
            document.documentElement.style.removeProperty("--stream-video-top")
            return
        }

        document.documentElement.style.setProperty("--stream-video-top", `calc(50% + ${this.streamVideoTopOffsetPx}px)`)
    }
    private updateKeyboardFloatingButtonPosition() {
        const screenKeyboard = this.sidebar.getScreenKeyboard()
        const visualViewport = window.visualViewport
        if (!screenKeyboard.isVisible() || !visualViewport) {
            this.resetKeyboardFloatingButtonPosition()
            return
        }

        const bottomInset = Math.min(16, visualViewport.height * 0.08)
        const buttonTop = visualViewport.offsetTop + visualViewport.height - bottomInset
        document.documentElement.style.setProperty("--stream-keyboard-button-top", `${buttonTop}px`)
    }
    private resetKeyboardFloatingButtonPosition() {
        document.documentElement.style.removeProperty("--stream-keyboard-button-top")
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }

    getStreamRect(): DOMRect {
        // The bounding rect of the videoElement or canvasElement can be bigger than the actual video
        // -> We need to correct for this when sending positions, else positions are wrong
        return this.stream.getVideoRenderer()?.getStreamRect() ?? new DOMRect()
    }
    getStream(): Stream | null {
        return this.stream
    }
}

class ViewerSidebar implements Component, Sidebar {
    private app: ViewerApp

    private div = document.createElement("div")

    private buttonDiv = document.createElement("div")

    private sendKeycodeButton = document.createElement("button")

    private keyboardButton = document.createElement("button")
    private floatingKeyboardButton = document.createElement("button")
    private screenKeyboard = new ScreenKeyboard()

    private lockMouseButton = document.createElement("button")
    private fullscreenButton = document.createElement("button")

    private statsButton = document.createElement("button")
    private exitStreamButton = document.createElement("button")

    private mouseMode: SelectComponent
    private scrollMode: SelectComponent
    private scrollSensitivity: SelectComponent
    private touchMode: SelectComponent

    constructor(app: ViewerApp) {
        this.app = app

        // Configure divs
        this.div.classList.add("sidebar-stream")

        this.buttonDiv.classList.add("sidebar-stream-buttons")
        this.div.appendChild(this.buttonDiv)

        // Send keycode
        this.sendKeycodeButton.innerText = I.stream.sendKeycode
        this.sendKeycodeButton.addEventListener("click", async () => {
            const key = await showModal(new SendKeycodeModal())

            if (key == null) {
                return
            }

            this.app.getStream()?.getInput().sendKey(true, key, emptyKeyModifiers())
            this.app.getStream()?.getInput().sendKey(false, key, emptyKeyModifiers())
        })
        this.buttonDiv.appendChild(this.sendKeycodeButton)

        // Pointer Lock
        this.lockMouseButton.innerText = I.stream.lockMouse
        this.lockMouseButton.addEventListener("click", async () => {
            await this.app.requestPointerLock(true)
        })
        this.buttonDiv.appendChild(this.lockMouseButton)

        // Pop up keyboard
        this.keyboardButton.innerText = I.stream.keyboard
        this.keyboardButton.addEventListener("click", async () => {
            setSidebarExtended(false)
            this.screenKeyboard.show()
        })
        this.buttonDiv.appendChild(this.keyboardButton)

        this.floatingKeyboardButton.innerText = "⌨×"
        this.floatingKeyboardButton.title = I.stream.hideKeyboard
        this.floatingKeyboardButton.ariaLabel = I.stream.hideKeyboard
        this.floatingKeyboardButton.classList.add("stream-keyboard-floating-button")
        this.floatingKeyboardButton.addEventListener("click", event => {
            event.preventDefault()
            event.stopPropagation()
            this.screenKeyboard.hide()
        })
        stopPropagationOn(this.floatingKeyboardButton)
        this.screenKeyboard.addKeyDownListener(this.onKeyDown.bind(this))
        this.screenKeyboard.addKeyUpListener(this.onKeyUp.bind(this))
        this.screenKeyboard.addTextListener(this.onText.bind(this))
        this.screenKeyboard.addKeyboardModeWillChangeListener(this.app.onScreenKeyboardModeWillChange.bind(this.app))
        this.screenKeyboard.addKeyboardModeListener(this.onKeyboardModeChange.bind(this))
        this.div.appendChild(this.screenKeyboard.getHiddenElement())


        // Fullscreen
        this.fullscreenButton.innerText = I.stream.fullscreen
        this.fullscreenButton.addEventListener("click", async () => {
            if (this.app.isFullscreen()) {
                this.app.markManualFullscreenExitRequested()
                await this.app.exitFullscreen()
            } else {
                await this.app.requestFullscreen()
            }
        })
        this.buttonDiv.appendChild(this.fullscreenButton)

        // Stats
        this.statsButton.innerText = I.stream.stats
        this.statsButton.addEventListener("click", () => {
            const stats = this.app.getStream()?.getStats()
            if (stats) {
                stats.toggle()
            }
        })
        this.buttonDiv.appendChild(this.statsButton)

        // Close stream
        this.exitStreamButton.innerText = I.stream.exit
        this.exitStreamButton.addEventListener("click", async () => {
            const stream = this.app.getStream()
            if (stream) {
                const success = await stream.stop()
                if (!success) {
                    console.debug("Failed to close stream correctly")
                }
            }

            if (window.matchMedia('(display-mode: standalone)').matches) {
                history.back()
            } else {
                window.close()
            }

        })
        this.buttonDiv.appendChild(this.exitStreamButton)

        // Select Mouse Mode
        this.mouseMode = new SelectComponent("mouseMode", [
            { value: "relative", name: I.stream.relative },
            { value: "follow", name: I.stream.follow },
            { value: "localCursor", name: I.stream.localCursor },
            { value: "pointAndDrag", name: I.stream.pointAndDrag }
        ], {
            displayName: I.stream.mouseMode,
            preSelectedOption: this.app.getInputConfig().mouseMode
        })
        this.mouseMode.addChangeListener(this.onMouseModeChange.bind(this))
        this.mouseMode.mount(this.div)

        this.scrollMode = new SelectComponent("liveScrollMode", [
            { value: "highres", name: I.settings.highRes },
            { value: "normal", name: I.settings.normal },
        ], { displayName: I.settings.scrollMode, preSelectedOption: this.app.getInputConfig().mouseScrollMode })
        this.scrollMode.addChangeListener(() => this.updateScrollSettings())
        this.scrollMode.mount(this.div)
        this.scrollSensitivity = new SelectComponent("liveScrollSensitivity", Array.from({ length: 16 }, (_, index) => (index + 1) / 4).map(value => ({ value: String(value), name: `${value}×` })), {
            displayName: I.settings.scrollSensitivity, preSelectedOption: String(this.app.getInputConfig().scrollSensitivity),
        })
        this.scrollSensitivity.addChangeListener(() => this.updateScrollSettings())
        this.scrollSensitivity.mount(this.div)

        // Select Touch Mode
        this.touchMode = new SelectComponent("touchMode", [
            { value: "touch", name: I.stream.touch },
            { value: "mouseRelative", name: I.stream.relative },
            { value: "localCursor", name: I.stream.localCursor },
            { value: "pointAndDrag", name: I.stream.pointAndDrag }
        ], {
            displayName: I.stream.touchMode,
            preSelectedOption: this.app.getInputConfig().touchMode
        })
        this.touchMode.addChangeListener(this.onTouchModeChange.bind(this))
        this.touchMode.mount(this.div)
    }

    onCapabilitiesChange(capabilities: StreamCapabilities) {
        this.touchMode.setOptionEnabled("touch", capabilities.touch)
    }

    getScreenKeyboard(): ScreenKeyboard {
        return this.screenKeyboard
    }

    // -- Keyboard
    private onText(event: TextEvent) {
        this.app.getStream()?.getInput().sendText(event.detail.text)
    }
    private onKeyDown(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyDown(event)
    }
    private onKeyUp(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyUp(event)
    }
    private onKeyboardModeChange(event: KeyboardModeEvent) {
        if (event.detail.enabled) {
            this.floatingKeyboardButton.classList.add("visible")
        } else {
            this.floatingKeyboardButton.classList.remove("visible")
            this.app.resetKeyboardViewportVideoOffset()
        }
    }

    // -- Mouse Mode
    private updateScrollSettings() {
        const config = { ...this.app.getInputConfig(),
            mouseScrollMode: this.scrollMode.getValue() === "normal" ? "normal" as const : "highres" as const,
            scrollSensitivity: Number(this.scrollSensitivity.getValue()),
        }
        this.app.setInputConfig(config)
        // Store only these preferences; don't overwrite unrelated settings.
        try {
            const saved = JSON.parse(localStorage.getItem("mlSettings") || "{}")
            saved.mouseScrollMode = config.mouseScrollMode
            saved.scrollSensitivity = config.scrollSensitivity
            localStorage.setItem("mlSettings", JSON.stringify(saved))
        } catch { /* live settings still work when storage is unavailable */ }
    }

    private onMouseModeChange() {
        const config = this.app.getInputConfig()
        config.mouseMode = this.mouseMode.getValue() as any
        this.app.setInputConfig(config)
    }

    // -- Touch Mode
    private onTouchModeChange() {
        const config = this.app.getInputConfig()
        config.touchMode = this.touchMode.getValue() as any
        this.app.setInputConfig(config)
    }

    extended(): void {

    }
    unextend(): void {

    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
        const appRoot = document.getElementById("root")
            ; (appRoot ?? document.body).appendChild(this.floatingKeyboardButton)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
        if (this.floatingKeyboardButton.parentElement) {
            this.floatingKeyboardButton.parentElement.removeChild(this.floatingKeyboardButton)
        }
    }
}

class SendKeycodeModal extends FormModal<number> {

    private dropdownSearch: SelectComponent

    constructor() {
        super()

        const keyList = []
        for (const keyNameRaw in StreamKeys) {
            const keyName = keyNameRaw as keyof typeof StreamKeys
            const keyValue = StreamKeys[keyName]

            const PREFIX = "VK_"

            let name: string = keyName
            if (name.startsWith(PREFIX)) {
                name = name.slice(PREFIX.length)
            }

            keyList.push({
                value: keyValue.toString(),
                name
            })
        }

        this.dropdownSearch = new SelectComponent("winKeycode", keyList, {
            hasSearch: true,
            displayName: I.stream.selectKeycode
        })
    }

    mountForm(form: HTMLFormElement): void {
        this.dropdownSearch.mount(form)
    }


    reset(): void {
        this.dropdownSearch.reset()
    }

    submit(): number | null {
        const keyString = this.dropdownSearch.getValue()
        if (keyString == null) {
            return null
        }

        return parseInt(keyString)
    }
}
