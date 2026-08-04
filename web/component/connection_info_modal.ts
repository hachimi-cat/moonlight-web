import { Modal, showModal } from "./modal/index"
import { showNotification } from "./notification"
import { getCurrentLanguage, getTranslations } from "../i18n"
import type { InfoEvent } from "../stream/index"
import type { LogMessageType } from "../stream/log"

// Extracted from stream.ts so the visual harness can mount it without
// executing the stream page's bootstrap (importing stream.ts runs main()).
// Type-only imports for stream/* keep this file out of any runtime cycle.

const I = getTranslations(getCurrentLanguage())

export class ConnectionInfoModal implements Modal<void> {

    private eventTarget = new EventTarget()

    private root = document.createElement("div")

    private head = document.createElement("div")
    private spinner = document.createElement("span")
    private title = document.createElement("h3")

    private textTy: LogMessageType | null = null
    private text = document.createElement("p")

    private options = document.createElement("div")
    private debugDetailButton = document.createElement("button")
    private closeButton = document.createElement("button")

    private debugDetail = "" // We store this seperate because line breaks don't work when the element is not mounted on the dom
    private debugDetailDisplay = document.createElement("div")

    constructor() {
        this.root.classList.add("modal-video-connect")

        // Title row: spinner + state. The stage detail lives in `text`
        // below, so the headline no longer competes with the log lines.
        this.head.classList.add("pw-connect-head")
        this.spinner.classList.add("pw-connect-spinner")
        this.head.appendChild(this.spinner)
        this.title.classList.add("pw-connect-title")
        this.title.innerText = I.stream.connecting
        this.head.appendChild(this.title)
        this.root.appendChild(this.head)

        this.text.classList.add("pw-connect-text")
        this.root.appendChild(this.text)

        this.root.appendChild(this.options)
        this.options.classList.add("modal-video-connect-options", "pw-connect-actions")

        this.debugDetailButton.innerText = I.stream.showLogs
        this.debugDetailButton.addEventListener("click", this.onDebugDetailClick.bind(this))
        this.options.appendChild(this.debugDetailButton)

        this.closeButton.innerText = I.stream.close
        this.closeButton.addEventListener("click", this.onClose.bind(this))
        this.options.appendChild(this.closeButton)

        this.debugDetailDisplay.classList.add("modal-video-connect-debug", "pw-connect-log")
    }

    private onDebugDetailClick() {
        let debugDetailCurrentlyShown = this.root.contains(this.debugDetailDisplay)

        if (debugDetailCurrentlyShown) {
            this.debugDetailButton.innerText = I.stream.showLogs
            this.root.removeChild(this.debugDetailDisplay)
        } else {
            this.debugDetailButton.innerText = I.stream.hideLogs
            this.root.appendChild(this.debugDetailDisplay)
            this.debugDetailDisplay.innerText = this.debugDetail
        }
    }

    private debugLog(line: string) {
        this.debugDetail += `${line}\n`
        this.debugDetailDisplay.innerText = this.debugDetail
        console.info(`[Stream]: ${line}`)
    }

    onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "connectionComplete") {
            const text = I.stream.connectionComplete
            this.title.innerText = text
            this.debugLog(text)

            showModal(null)
        } else if (data.type == "addDebugLine") {
            const message = data.line.trim()
            if (message) {
                this.debugLog(message)

                if (!this.textTy) {
                    this.text.innerText = message
                    this.textTy = data.additional?.type ?? null
                } else if (data.additional?.type == "fatalDescription" || data.additional?.type == "ifErrorDescription") {
                    if (this.text.innerText) {
                        this.text.innerText += "\n" + message
                    } else {
                        this.text.innerText = message
                    }
                    this.textTy = data.additional.type
                }
            }

            if (data.additional?.type == "fatal" || data.additional?.type == "fatalDescription") {
                // Terminal: the spinner would be a lie, and "Connecting"
                // over a failure message reads as still trying.
                this.root.classList.add("pw-connect-failed")
                this.title.innerText = I.stream.connectionFailed
                showModal(this)
            } else if (data.additional?.type == "informError") {
                showNotification(data.line)
            }
        }
    }

    onClose() {
        showModal(null)
    }

    onFinish(abort: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            this.eventTarget.addEventListener("ml-connected", () => resolve(), { once: true, signal: abort })
        })
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }
}
