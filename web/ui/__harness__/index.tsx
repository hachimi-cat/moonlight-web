/*
 * Local-only visual harness for the React islands. Not part of any release
 * bundle — built by webpack.harness.js, which is not referenced by
 * `npm run build`.
 *
 * It exists because the real settings panel needs a live stream session to
 * open, so this is the only way to LOOK at these components while iterating.
 * It proves rendering and styling, NOT integration.
 */
import { ShadcnSelectComponent } from "../shadcn-select"
import { ShadcnInputComponent } from "../shadcn-input"

const app = document.getElementById("app")!

function panel(title: string): HTMLElement {
    const section = document.createElement("section")
    section.className = "panel"
    const h = document.createElement("h2")
    h.innerText = title
    section.appendChild(h)
    app.appendChild(section)
    return section
}

const video = panel("Video")

const codec = new ShadcnSelectComponent(
    "videoCodec",
    [
        { value: "h264", name: "H.264" },
        { value: "h265", name: "H.265 (HEVC)" },
        { value: "av1", name: "AV1" },
    ],
    { displayName: "Video codec", preSelectedOption: "h265" },
)
codec.mount(video)

const size = new ShadcnSelectComponent(
    "videoSize",
    [
        { value: "720p", name: "1280 x 720" },
        { value: "1080p", name: "1920 x 1080" },
        { value: "1440p", name: "2560 x 1440" },
        { value: "4k", name: "3840 x 2160" },
        { value: "native", name: "Match my screen" },
    ],
    { displayName: "Resolution", preSelectedOption: "1080p" },
)
size.mount(video)

// One option disabled, to show the state — AV1 is commonly unsupported.
const transport = new ShadcnSelectComponent(
    "transport",
    [
        { value: "webrtc", name: "WebRTC" },
        { value: "websocket", name: "WebSocket" },
        { value: "unavailable", name: "QUIC (unsupported here)" },
    ],
    { displayName: "Data transport", preSelectedOption: "webrtc" },
)
transport.mount(video)
transport.setOptionEnabled("unavailable", false)

const input = panel("Input")

const nothingChosen = new ShadcnSelectComponent(
    "mouseMode",
    [
        { value: "absolute", name: "Absolute" },
        { value: "relative", name: "Relative (capture pointer)" },
    ],
    { displayName: "Mouse mode (nothing selected yet)" },
)
nothingChosen.mount(input)

const fullscreen = new ShadcnInputComponent(
    "enterFullscreen",
    "checkbox",
    "Enter fullscreen on stream start",
    { checked: true },
)
fullscreen.mount(input)

const localCursor = new ShadcnInputComponent("playAudioLocal", "checkbox", "Play audio locally")
localCursor.mount(input)

const numbers = panel("Bitrate & queues")

const bitrate = new ShadcnInputComponent("bitrate", "number", "Bitrate (Mbps)", {
    value: "25",
    step: "5",
    numberSlider: { range_min: 5, range_max: 150 },
})
bitrate.mount(numbers)

const queue = new ShadcnInputComponent("videoFrameQueueSize", "number", "Video frame queue", {
    value: "2",
    step: "1",
    numberSlider: { range_min: 0, range_max: 16 },
})
queue.mount(numbers)

const plain = new ShadcnInputComponent("customPort", "number", "Custom port (plain number)", {
    value: "47989",
})
plain.mount(numbers)

const guarded = new ShadcnInputComponent("overrideFps", "number", "Override fps (off by default)", {
    value: "60",
    hasEnableCheckbox: true,
    numberSlider: { range_min: 30, range_max: 120 },
})
guarded.mount(numbers)

const text = panel("Text & file")

const host = new ShadcnInputComponent("hostName", "text", "Host name", {
    placeholer: "gaming-rig.local",
})
host.mount(text)

const password = new ShadcnInputComponent("password", "password", "Password", {
    formRequired: true,
})
password.mount(text)

const file = new ShadcnInputComponent("passwordFile", "file", "Password as file", {
    accept: ".txt",
})
file.mount(text)

// Echo changes so the harness proves the ml-change event still fires with the
// same shape the vanilla component used.
const log = document.getElementById("log")!
for (const c of [codec, size, transport, nothingChosen]) {
    c.addChangeListener(() => {
        log.innerText = `ml-change -> ${c.getValue()}`
    })
}

for (const c of [fullscreen, localCursor, bitrate, queue, plain, guarded, host, password]) {
    c.addChangeListener(() => {
        const v = c.isChecked() ? "checked" : c.getValue()
        log.innerText = `ml-change -> ${v} (enabled=${c.isEnabled()})`
    })
}

// Notifications: fire one of each level so the toast stack can be seen and
// its dismiss/auto-expiry behaviour exercised.
import { showNotification } from "../../component/notification"

showNotification("Lost connection to the host. Retrying…", "error")
showNotification("H.265 is not supported by this browser; fell back to H.264.", "warn")
showNotification("Paired with pawpado-browser.", "info")

// The REAL settings panel, constructed with a permissive role. This is the
// component customers actually see in the stream sidebar — far better as a
// visual check than the hand-built panels above.
import { StreamSettingsComponent, globalDefaultSettings } from "../../component/settings_menu"
import type { StreamPermissions } from "../../api_bindings"

const permissions: StreamPermissions = {
    allow_add_hosts: true,
    maximum_bitrate_kbps: null,
    allow_codec_h264: true,
    allow_codec_h265: true,
    allow_codec_av1: true,
    allow_hdr: true,
    allow_transport_webrtc: true,
    allow_transport_websockets: true,
}

const realPanel = document.createElement("section")
realPanel.className = "panel panel-wide"
const realHeading = document.createElement("h2")
realHeading.innerText = "Real stream settings panel"
realPanel.appendChild(realHeading)
app.appendChild(realPanel)

new StreamSettingsComponent(permissions, globalDefaultSettings()).mount(realPanel)
