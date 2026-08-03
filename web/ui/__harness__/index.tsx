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

// Echo changes so the harness proves the ml-change event still fires with the
// same shape the vanilla component used.
const log = document.getElementById("log")!
for (const c of [codec, size, transport, nothingChosen]) {
    c.addChangeListener(() => {
        log.innerText = `ml-change -> ${c.getValue()}`
    })
}
