import { Api, fetchApi, WebRTCAnswer } from "../../api"
import { ClientInputEvent, ControlPacket, ControlPacketConfig, controlPacketDeserialize, controlPacketSerialize, ControlStream, ControlStreamEvent, ControlStreamEvent_Tags, EstimatedRttInfo, InputBatcher, PacketDirection, UdpTransmit, VideoFormats, WebRtcSessionAnswer, webrtcSessionAnswerParse, WebRtcSessionOffer, webrtcSessionOfferApply } from "../../uniffi/moonlight_common_bindings"
import { globalObject, uniffiMillisUntil, uniffiNow, wait } from "../../util"
import { AudioPlayer, TrackAudioPlayer } from "../audio/index"
import { Logger } from "../log"
import { DataPipe } from "../pipeline/pipes"
import { StatValue } from "../stats"
import { TrackVideoRenderer, VideoRenderer } from "../video/index"
import { generateControlPacketConfig, IControlStream, Transport, TransportAudioType, TransportConnectData, TransportOptions, TransportShutdown, TransportVideoType } from "./index"

export class WebRTCTransport implements Transport {

    readonly implementationName: string = "webrtc"

    readonly controlStream = new WebRtcControlStream()
    onconnect: ((connectData: TransportConnectData) => void) | null = null
    onclose: ((shutdown: TransportShutdown) => void) | null = null

    private logger?: Logger

    private api: Api

    private peer: RTCPeerConnection
    private location: string | null = null

    /**
     * A WebRTC peer can remain `connected` after its media path has stopped.
     * The data channel and ICE consent checks still succeed in that state,
     * so connectionstatechange never gives the viewer a chance to recover.
     * Watch cumulative RTP counters and deliberately renegotiate instead of
     * leaving a frozen last frame on screen forever.
     */
    private mediaWatchdogTimer: number | null = null
    private mediaReceived = false
    private lastMediaPacketCount: number | null = null
    private lastMediaProgressAt = 0
    private lastVideoFramesDecoded: number | null = null
    private lastVideoFrameProgressAt = 0
    private shutdownSignaled = false
    private mediaWatchdogRunning = false
    private preserveMoonlightSession: boolean
    private iceRestartRunning = false

    private static readonly MEDIA_WATCHDOG_INTERVAL_MS = 2000
    private static readonly MEDIA_STALL_MS = 8000
    // DirectX games can briefly stop producing complete desktop-duplication
    // frames while entering/exiting exclusive fullscreen. BioShock Infinite
    // takes roughly 9-10 seconds on the Pawpado A10G host; treating that as a
    // dead transport at four seconds creates a reconnect/mode-switch loop and
    // leaves the player with audio over a black picture. Packet-total stalls
    // still recover at 8 seconds; allow a longer grace only when partial RTP
    // or audio continues but no complete video frame is decoded.
    private static readonly VIDEO_FRAME_STALL_MS = 15000

    constructor(api: Api, configuration: RTCConfiguration, logger?: Logger, preserveMoonlightSession: boolean = false) {
        this.logger = logger
        this.preserveMoonlightSession = preserveMoonlightSession

        this.api = api

        // Create peer
        this.peer = new RTCPeerConnection(configuration)

        this.logger?.debug(`Using ice servers ${JSON.stringify(configuration.iceServers?.flatMap(server => server.urls))}`)

        // Set Event Listeners
        this.peer.addEventListener("connectionstatechange", this.onStateChange.bind(this))
        this.peer.addEventListener("datachannel", this.onDataChannel.bind(this))
        this.peer.addEventListener("track", this.onTrack.bind(this))

        // Ice Gathering
        this.peer.addEventListener("icecandidate", this.onIceCandidate.bind(this))

        // Add Media
        this.peer.addTransceiver("video", { direction: "recvonly" })
        this.peer.addTransceiver("audio", { direction: "recvonly" })

        // Dummy data channel required so that the answerer knows we accept data channels
        this.peer.createDataChannel("dummy")
    }

    private sdpOfferOptions: WebRtcSessionOffer | null = null
    private sdpAnswer: WebRtcSessionAnswer | null = null

    async createOffer(options: TransportOptions): Promise<string> {
        this.logger?.debug("Creating webrtc offer")

        let offer = await this.peer.createOffer()
        if (offer.type != "offer") {
            throw `WHEP offer is of type ${offer.type}`
        }

        this.logger?.debug("Setting webrtc local description")
        await this.peer.setLocalDescription(offer)

        // Insert custom options
        this.sdpOfferOptions = {
            controlEnet: true,
            ...options
        }
        const sdp = webrtcSessionOfferApply(offer.sdp ?? "", this.sdpOfferOptions)

        this.logger?.debug(`successfully generated webrtc sdp with options ${JSON.stringify(this.sdpOfferOptions)}`)
        console.debug("Client Sdp", sdp)

        this.logger?.debug(`starting ice candidate sender`)
        this.sendIceCandidates()

        return sdp
    }
    async setAnswer(response: WebRTCAnswer): Promise<void> {
        console.debug("server sdp", JSON.stringify(response))

        this.logger?.debug(`received whep response with location "${response.location}"`)
        // Print ice candidates
        for (const line of response.answerSdp.split("\r\n")) {
            if (line.startsWith("a=candidate")) {
                this.logger?.debug(`received remove ice candidate ${line.substring(2)}`)
            }
        }

        this.location = response.location

        this.sdpAnswer = webrtcSessionAnswerParse(response.answerSdp)
        this.logger?.debug(`Server responded with extensions ${JSON.stringify(this.sdpAnswer)}`)

        await this.peer.setRemoteDescription({
            type: "answer",
            sdp: response.answerSdp,
        })
    }

    private connectData: TransportConnectData | null = null
    private async generateConnectData(): Promise<TransportConnectData> {
        if (this.connectData) {
            return this.connectData
        }

        if (!this.videoStream || !this.audioStream) {
            throw `WebRTC WHEP response didn't contain a video and audio stream! Video: ${this.videoStream != null}, Audio: ${this.audioStream != null}`
        }
        const codec = await this.findOutCodec()

        const audioSettings = this.audioStream.getSettings()

        this.connectData = {
            capabilities: {
                touch: false
            },
            videoType: "videotrack",
            videoSetup: {
                // Assume the requested parameters are correct
                width: this.sdpOfferOptions?.width ?? -1,
                height: this.sdpOfferOptions?.height ?? -1,
                fps: this.sdpOfferOptions?.fps ?? -1,
                codec,
            },
            audioType: "audiotrack",
            audioSetup: {
                channels: audioSettings.channelCount ?? 2,
                sampleRate: audioSettings.sampleRate ?? 48000,
                // TODO
                streams: 0,
                coupledStreams: 0,
                samplesPerFrame: 0,
                mapping: []
            },
            appName: this.sdpAnswer?.appName ?? "Unknown"
        }
        return this.connectData
    }

    private wasConnected = false
    private onStateChange() {
        if (this.peer.connectionState == "connected") {
            this.wasConnected = true
            this.startMediaWatchdog()

            this.generateConnectData().then(connectData => {
                if (this.onconnect) {
                    this.onconnect(connectData)
                }
            })
        } else if (this.peer.connectionState == "failed" || this.peer.connectionState == "closed") {
            this.stopMediaWatchdog()
            const shutdown = this.wasConnected ? "failed" : "failednoconnect"

            this.signalShutdown(shutdown)
        }
    }

    private signalShutdown(shutdown: TransportShutdown) {
        if (this.shutdownSignaled) {
            return
        }
        this.shutdownSignaled = true
        this.onclose?.(shutdown)
    }

    private startMediaWatchdog() {
        if (this.mediaWatchdogTimer != null) {
            return
        }
        this.lastMediaProgressAt = Date.now()
        this.lastVideoFrameProgressAt = this.lastMediaProgressAt
        this.mediaWatchdogTimer = globalObject().setInterval(
            () => void this.checkMediaProgress(),
            WebRTCTransport.MEDIA_WATCHDOG_INTERVAL_MS,
        )
    }

    private stopMediaWatchdog() {
        if (this.mediaWatchdogTimer != null) {
            globalObject().clearInterval(this.mediaWatchdogTimer)
            this.mediaWatchdogTimer = null
        }
    }

    private async checkMediaProgress() {
        if (this.mediaWatchdogRunning || this.shutdownSignaled || this.peer.connectionState != "connected") {
            return
        }
        this.mediaWatchdogRunning = true
        try {
            const stats = await this.peer.getStats()
            let mediaPacketCount = 0
            let videoReceived: number | null = null
            let videoFramesDecoded: number | null = null

            for (const [_key, value] of stats) {
                if (value.type != "inbound-rtp") {
                    continue
                }
                if (typeof value.packetsReceived == "number") {
                    mediaPacketCount += value.packetsReceived
                }
                if (value.kind == "video") {
                    videoReceived = typeof value.packetsReceived == "number" ? value.packetsReceived : null
                    videoFramesDecoded = typeof value.framesDecoded == "number" ? value.framesDecoded : null
                }
            }

            const now = Date.now()
            if (this.lastMediaPacketCount == null || mediaPacketCount > this.lastMediaPacketCount) {
                if (mediaPacketCount > 0) {
                    this.mediaReceived = true
                }
                this.lastMediaProgressAt = now
            }

            // Packet loss while ICE is still connected is congestion, not a
            // dead route. Restarting ICE cannot choose a different path here
            // (the same host/prflx UDP pair wins again), and every restart
            // closes the active socket while the host is still writing RTP.
            // In production that turned one lossy two-second interval into a
            // reconnect every 5-20 seconds plus thousands of WSAENETUNREACH
            // send failures. Let WebRTC congestion control, NACK and FEC do
            // their jobs; recover only when media actually stops progressing.

            if (videoFramesDecoded != null) {
                if (this.lastVideoFramesDecoded == null
                    || videoFramesDecoded > this.lastVideoFramesDecoded
                ) {
                    this.lastVideoFrameProgressAt = now
                }

                this.lastVideoFramesDecoded = videoFramesDecoded

                // Audio or partial video RTP can keep the aggregate packet
                // counter advancing while the browser receives no complete
                // video frames. Treat that as a video stall instead of
                // leaving the user on an increasingly stale picture.
                if (this.mediaReceived && videoReceived != null && videoReceived > 0
                    && document.visibilityState == "visible"
                    && now - this.lastVideoFrameProgressAt >= WebRTCTransport.VIDEO_FRAME_STALL_MS
                ) {
                    this.logger?.debug(
                        `WebRTC video decoded no complete frames for ` +
                        `${WebRTCTransport.VIDEO_FRAME_STALL_MS}ms; reconnecting`,
                    )
                    await this.closeForRecovery("stalled")
                    return
                }
            }

            this.lastMediaPacketCount = mediaPacketCount

            // Timers are throttled in background tabs. Only declare a stall
            // while visible; when the tab returns, the next progressing
            // sample refreshes the clock without disrupting the session.
            if (this.mediaReceived && document.visibilityState == "visible"
                && now - this.lastMediaProgressAt >= WebRTCTransport.MEDIA_STALL_MS
            ) {
                this.logger?.debug(
                    `WebRTC media received no packets for ${WebRTCTransport.MEDIA_STALL_MS}ms; reconnecting`,
                )
                await this.closeForRecovery("stalled")
            }
        } catch (error) {
            this.logger?.debug(`failed to sample WebRTC media health: ${error}`)
        } finally {
            this.mediaWatchdogRunning = false
        }
    }

    private async closeForRecovery(reason: "degraded" | "stalled") {
        if (this.shutdownSignaled) {
            return
        }

        if (this.preserveMoonlightSession) {
            await this.restartIceInPlace(reason)
            return
        }

        // Suppress connectionstatechange while deliberately closing. Wait
        // for the server-side Moonlight stream to be deleted before asking
        // it to resume the same app, otherwise the two negotiations race.
        this.shutdownSignaled = true
        this.stopMediaWatchdog()
        this.peer.close()
        const location = this.location
        this.location = null
        try {
            if (location) {
                await fetchApi(this.api, location, "DELETE", {
                    keepalive: true,
                    noUrlModify: true,
                    response: "ignore",
                })
            }
        } catch (error) {
            this.logger?.debug(`failed to close stalled WebRTC transport: ${error}`)
        }
        this.onclose?.(reason)
    }

    /**
     * Repair a dead browser-facing RTP route without deleting the WHEP
     * resource. The server renegotiates the existing RTCPeerConnection, so
     * its Moonlight connection to Apollo and the already-created ViGEm pad
     * never go away.
     */
    private async restartIceInPlace(reason: "degraded" | "stalled") {
        if (this.iceRestartRunning || !this.location) {
            return
        }
        this.iceRestartRunning = true
        this.stopMediaWatchdog()

        try {
            if (this.iceCandidateSendTimer != null) {
                globalObject().clearTimeout(this.iceCandidateSendTimer)
                this.iceCandidateSendTimer = null
            }
            this.pendingIceCandidates = []

            this.logger?.debug(
                `WebRTC media ${reason}; restarting ICE without disconnecting the controller`,
                { type: "recover" },
            )
            const offer = await this.peer.createOffer({ iceRestart: true })
            await this.peer.setLocalDescription(offer)
            if (!offer.sdp) {
                throw new Error("ICE restart offer contained no SDP")
            }

            const response = await fetchApi(this.api, this.location, "PATCH", {
                noUrlModify: true,
                sdp: offer.sdp,
                response: "ignore",
            }, 20000)
            const answerSdp = await response.text()
            await this.peer.setRemoteDescription({ type: "answer", sdp: answerSdp })

            // Reset the health baseline. If the repaired route still carries
            // no media, the watchdog will retry after a fresh stall window.
            const now = Date.now()
            this.mediaReceived = false
            this.lastMediaPacketCount = null
            this.lastMediaProgressAt = now
            this.lastVideoFramesDecoded = null
            this.lastVideoFrameProgressAt = now
            this.logger?.debug(
                "WebRTC ICE restart completed; controller session preserved",
                { type: "recover" },
            )
        } catch (error) {
            // Do not fall through to DELETE+POST for a controller launch: that
            // is exactly what migrates the virtual pad to another XInput slot.
            // Leave the peer in place and retry after the next stall window.
            const now = Date.now()
            this.lastMediaProgressAt = now
            this.lastVideoFrameProgressAt = now
            this.logger?.debug(
                `in-place WebRTC ICE restart failed: ${error}`,
                { type: "recover" },
            )
        } finally {
            this.iceRestartRunning = false
            this.startMediaWatchdog()
        }
    }

    // -- Trickle Ice
    private iceCandidateSendTimer: number | null = null
    private pendingIceCandidates: Array<string> = []
    private onIceCandidate(event: RTCPeerConnectionIceEvent) {
        if (!event.candidate) {
            // Ice Gathering finished
            this.logger?.debug("ice gathering finished")
            return
        }

        const candidate = event.candidate.toJSON().candidate
        if (candidate) {
            this.pendingIceCandidates.push(candidate)
        }
    }

    private boundSendIceCandidates = this.sendIceCandidates.bind(this)
    private async sendIceCandidates() {
        this.iceCandidateSendTimer = null
        if (this.iceCandidateSendTimer != null) {
            globalObject().clearTimeout(this.iceCandidateSendTimer)
        }

        for (const candidate of this.pendingIceCandidates) {
            this.logger?.debug(`sending ice candidate: ${candidate}`)
        }

        if (this.location) {
            const trickleIceSdpFrag = this.pendingIceCandidates.map(x => `a=${x}`).join("\r\n")

            await fetchApi(this.api, this.location, "PATCH", {
                noUrlModify: true,
                trickleIceSdpFrag,
                response: "ignore",
            })

            this.pendingIceCandidates = []
        }

        if (this.peer.iceGatheringState != "complete") {
            this.iceCandidateSendTimer = globalObject().setTimeout(this.boundSendIceCandidates, 2000)
        }
    }

    // -- Control Stream / Media
    private onDataChannel(event: RTCDataChannelEvent) {
        const channel = event.channel

        this.logger?.debug(`received data channel with label: ${channel.label}, protocol: ${channel.protocol}`)

        if (channel.label == "moonlight.control") {
            const config = generateControlPacketConfig()

            let protocol: "simple" | "enet" = "simple"
            if (channel.protocol == "enet") {
                protocol = "enet"
            }

            this.controlStream.setChannel(channel, protocol, config)
        }
    }

    private onTrack(event: RTCTrackEvent) {
        // Pawpado can request a tiny playout cushion. Its diagnostics showed
        // clean direct UDP and zero packet loss while a forced zero buffer
        // still ran out of frames, producing visible 33–50 ms cadence gaps.
        // Keep upstream's latency-first zero default for every other caller.
        const requestedBufferMs = Number(new URLSearchParams(location.search).get("pawpadoJitterBufferMs"))
        const jitterBufferMs = Number.isFinite(requestedBufferMs)
            ? Math.max(0, Math.min(200, requestedBufferMs))
            : 0
        event.receiver.jitterBufferTarget = jitterBufferMs
        if ("playoutDelayHint" in event.receiver) {
            event.receiver.playoutDelayHint = jitterBufferMs / 1000
        }
        const track = event.track

        this.logger?.debug(`received track with label: ${track.label}, kind: ${track.kind}`)

        if (track.kind == "video") {
            track.contentHint = "motion"

            this.videoStream = track
        } else if (track.kind == "audio") {
            this.audioStream = track
        }
    }

    // Video
    private videoStream: MediaStreamTrack | null = null

    setVideoPipeline(type: "videotrack", pipeline: (TrackVideoRenderer & VideoRenderer)): Promise<void>;
    setVideoPipeline(type: "data", pipeline: (DataPipe & VideoRenderer)): Promise<void>;
    async setVideoPipeline(type: TransportVideoType, pipeline: unknown): Promise<void> {
        if (!this.videoStream || !this.connectData) {
            throw "the stream must be connected!"
        }

        if (type == "videotrack") {
            const trackPipeline = pipeline as (TrackVideoRenderer & VideoRenderer)

            trackPipeline.setTrack(this.videoStream)
        } else if (type == "data") {
            throw "unimplemented"
        }
    }

    // Audio
    private audioStream: MediaStreamTrack | null = null

    setAudioPipeline(type: "audiotrack", pipeline: (TrackAudioPlayer & AudioPlayer)): Promise<void>
    setAudioPipeline(type: "data", pipeline: (DataPipe & AudioPlayer)): Promise<void>
    async setAudioPipeline(type: TransportAudioType, pipeline: AudioPlayer): Promise<void> {
        if (!this.audioStream || !this.connectData) {
            throw "the stream must be connected!"
        }

        if (type == "audiotrack") {
            const trackPipeline = pipeline as (TrackAudioPlayer & AudioPlayer)

            trackPipeline.setTrack(this.audioStream)
        } else if (type == "data") {
            throw "unimplemented"
        }
    }

    async close(): Promise<void> {
        this.stopMediaWatchdog()

        // Close the peer
        this.peer.close()

        // Delete our current session on the server
        const location = this.location
        this.location = null
        if (location) {
            await fetchApi(this.api, location, "DELETE", {
                keepalive: true,
                noUrlModify: true,
                response: "ignore",
            })
        }
    }

    private async findOutCodec(): Promise<keyof VideoFormats> {
        let tries = 0

        while (true) {
            const stats = await this.peer.getStats()
            for (const [_key, value] of stats) {
                // Video Stream
                if ("type" in value && "kind" in value
                    && value.type == "inbound-rtp" && value.kind == "video"
                ) {

                }
            }
            tries += 1
            if (tries > 10) {
                this.logger?.debug(`failed to determine codec using stats after ${tries} tries, assuming h264`)
                return "h264"
            }

            await wait(100)
        }
    }

    private lastTotalDecodeTime = 0
    private lastFramesDecoded = 0
    async getStats(): Promise<Record<string, StatValue>> {
        const out: Record<string, StatValue> = {}

        // Control Stream
        try {
            const estimatedRtt = this.controlStream.estimatedRtt()
            if (estimatedRtt) {
                out.estimatedClientToRelayRttMs = estimatedRtt.rtt
                out.estimatedClientToRelayRttVarianceMs = estimatedRtt.rttVariance
            }
        } catch (error) {
            // Stats are observational. A transient ENet error during an ICE
            // restart must not become an unhandled notification over the game.
            this.logger?.debug(`control RTT temporarily unavailable: ${error}`)
        }

        const stats = await this.peer.getStats()

        for (const [_key, value] of stats) {

            // Video Stream
            if ("type" in value && "kind" in value
                && value.type == "inbound-rtp" && value.kind == "video"
            ) {
                out.resolution = `Width: ${value?.frameWidth}, Height: ${value?.frameHeight}`

                out.framesDecoded = value?.framesDecoded
                out.framesDropped = value?.framesDropped
                out.keyFramesDecoded = value?.keyFramesDecoded

                out.packetsLost = value?.packetsLost
                out.packetsReceived = value?.packetsReceived

                out.nackCount = value?.nackCount
                out.pliCount = value?.pliCount
                out.firCount = value?.firCount

                if ("totalDecodeTime" in value && "framesDecoded" in value) {
                    out.decodeTimePerFrameMs = (value.totalDecodeTime - this.lastTotalDecodeTime) / (value.framesDecoded - this.lastFramesDecoded) * 1000.0

                    this.lastFramesDecoded = value.framesDecoded
                    this.lastTotalDecodeTime = value.totalDecodeTime
                }

                out.currentFps = value?.framesPerSecond
            }
            if ("type" in value && "mimeType" in value && typeof value.mimeType == "string"
                && value.type == "codec" && value.mimeType.startsWith("video/")
            ) {
                out.codec = value.mimeType.substring(6)
                out.codecSdpFmtpLine = value?.sdpFmtpLine
            }

            // Audio Stream
        }

        return out
    }
}

const ENET_IP = "192.168.178.2:47999"

class WebRtcControlStream implements IControlStream {

    private logger?: Logger

    private config: ControlPacketConfig | null = null

    private channel: RTCDataChannel | null = null
    private streamType: "simple" | "enet" = "simple"

    private batcher: InputBatcher = new InputBatcher()

    // Enet control stream
    private controlStream: ControlStream | null = null
    private controlStreamPollTimeout: number | null = null
    private enetConnected = false

    private packetBuffer: Array<ControlPacket> = []
    private lastChannelSendFailureAt = 0

    constructor(logger?: Logger) {
        this.logger = logger
    }

    setChannel(channel: null): void
    setChannel(channel: RTCDataChannel, streamType: "simple" | "enet", config: ControlPacketConfig): void
    setChannel(channel: RTCDataChannel | null, streamType?: "simple" | "enet", config?: ControlPacketConfig): void {
        this.channel = channel

        // Clean up old control stream if present
        if (this.controlStream) {
            this.controlStream.uniffiDestroy()
            this.controlStream = null
        }
        if (this.controlStreamPollTimeout != null) {
            globalObject().clearTimeout(this.controlStreamPollTimeout)
        }
        this.enetConnected = false

        if (this.channel && streamType && config) {
            this.config = config
            this.streamType = streamType

            this.channel.binaryType = "arraybuffer"

            this.channel.addEventListener("open", this.boundChannelStateChange)
            this.channel.addEventListener("message", this.boundMessage)

            if (this.streamType == "enet") {
                this.controlStream = new ControlStream(uniffiNow(), {
                    serverVersion: this.config.serverVersion,
                    addr: ENET_IP,
                })
                this.onDataChannelStateChange()
            }

            this.trySendBufferedPackets()
        } else {
            this.streamType = "simple"
            this.channel?.removeEventListener("open", this.boundChannelStateChange)
            this.channel?.removeEventListener("message", this.boundMessage)
        }
    }

    onreceive: ((packet: ControlPacket) => void) | null = null

    private boundMessage = this.onMessage.bind(this)
    private onMessage(event: MessageEvent) {
        if (!this.config) {
            throw "packet config not configured, but a packet was received"
        }

        if (this.streamType == "simple") {
            const packet = controlPacketDeserialize(this.config, PacketDirection.ClientBound, event.data)

            if (packet && this.onreceive) {
                this.onreceive(packet)
            }
        } else if (this.streamType == "enet") {
            if (!this.controlStream) {
                throw "dropping packet because enet control stream is not initialized"
            }

            this.controlStream.handleReceive(
                uniffiNow(),
                ENET_IP,
                event.data
            )

            this.controlStreamPollOutput(false)
        } else {
            this.logger?.debug("failed to deserialize packet")
            console.debug("failed to deserialize packet", event.data)
        }
    }

    private boundChannelStateChange = this.onDataChannelStateChange.bind(this)
    private onDataChannelStateChange() {
        if (this.channel?.readyState == "open") {
            this.trySendBufferedPackets()

            if (this.streamType == "enet" && this.controlStreamPollTimeout == null) {
                // Start loop
                this.controlStreamPollOutput()
            }
        }
    }
    private trySendBufferedPackets() {
        if (!this.channel || this.channel.readyState != "open") {
            return
        }

        if (this.streamType == "enet" && !this.enetConnected) {
            return
        }

        // Send buffered packets
        for (const packet of this.packetBuffer.splice(0)) {
            this.sendRaw(packet)
        }
    }

    send(input: ClientInputEvent): void {
        for (const packet of this.batcher.batchInput(input)) {
            this.sendRaw(packet)
        }

        this.sendBatchedInputs()
    }

    sendRaw(packet: ControlPacket): void {

        if (
            !this.channel || this.channel.readyState != "open" ||
            (this.streamType == "enet" && (!this.controlStream || !this.enetConnected))
        ) {
            this.packetBuffer.push(packet)
            return
        }
        if (!this.config) {
            throw "packet config not configured, but a packet was sent"
        }

        this.trySendBufferedPackets()

        if (this.streamType == "simple") {
            const data = controlPacketSerialize(this.config, packet)
            // Same closed-channel guard as controlStreamPollOutput.
            if (data && this.channel.readyState == "open") {
                this.sendChannelData(data)
            }
        } else if (this.streamType == "enet") {
            // The ENet WASM layer can reject input while ICE is restarting
            // even though the RTCDataChannel still reports `open`. Treat it
            // like the adjacent channel.send failure instead of surfacing an
            // uncaught ControlStreamError for every mouse/gamepad packet.
            try {
                this.controlStream?.sendRaw(packet)
            } catch (error) {
                const now = Date.now()
                if (now - this.lastChannelSendFailureAt >= 5000) {
                    this.lastChannelSendFailureAt = now
                    this.logger?.debug(`control stream temporarily unwritable: ${error}`)
                }
                return
            }
            this.controlStreamPollOutput()
        } else {
            this.logger?.debug(`failed to send control packet ${JSON.stringify(packet)}`)
        }
    }

    estimatedRtt(): EstimatedRttInfo | null {
        return this.controlStream?.estimatedRtt() ?? null
    }

    private sendBatchedInputs() {
        for (const packet of this.batcher.removeBatchedInputs()) {
            this.sendRaw(packet)
        }
    }

    private boundPollOutput = this.controlStreamPollOutput.bind(this)
    private controlStreamPollOutput(handleInput = true) {
        if (this.controlStreamPollTimeout != null) {
            globalObject().clearTimeout(this.controlStreamPollTimeout)
        }
        this.controlStreamPollTimeout = null

        if (!this.controlStream) {
            return
        }
        if (!this.channel) {
            return
        }

        if (handleInput) {
            this.controlStream.handleTimeout(uniffiNow())
        }

        // This runs off a timer, so it keeps firing after the peer is gone.
        // send() on a non-open RTCDataChannel throws InvalidStateError, and
        // because nothing here catches it, that throw escaped as an uncaught
        // error at the end of every stream — the "object is in an invalid
        // state" players were seeing when they quit a game.
        if (this.channel.readyState != "open") {
            return
        }

        let send: UdpTransmit | undefined
        while (send = this.controlStream.pollPacket()) {
            this.sendChannelData(send.contents)
        }

        let event: ControlStreamEvent | undefined
        while (event = this.controlStream.pollEvent()) {
            if (event.tag === ControlStreamEvent_Tags.Connect) {
                this.enetConnected = true

                this.trySendBufferedPackets()
            } else if (event.tag === ControlStreamEvent_Tags.Packet) {
                if (this.onreceive) {
                    this.onreceive(event.inner[0]);
                }
            } else if (event.tag === ControlStreamEvent_Tags.Disconnect) {
                this.logger?.debug("control stream got disconnected for an unknown reason, constructing with new client control stream")
                this.enetConnected = false

                if (this.config) {
                    this.setChannel(this.channel, "enet", this.config)
                } else {
                    this.logger?.debug("failed to reconstruct new client control stream because of missing packet config")
                }
            }
        }

        const timeout = this.controlStream.pollTimeout()
        if (timeout != undefined) {
            this.controlStreamPollTimeout = globalObject().setTimeout(this.boundPollOutput, uniffiMillisUntil(timeout))
        }
    }

    /** RTCDataChannel.send() can throw while ICE is being repaired even when
     * readyState still says open. Do not turn high-rate mouse input into a
     * screen-covering flood of uncaught-error notifications. ENet will retry
     * reliable control packets after the channel becomes writable again. */
    private sendChannelData(data: ArrayBuffer | ArrayBufferView) {
        try {
            if (!this.channel) return
            if (data instanceof ArrayBuffer) {
                this.channel.send(data)
            } else {
                // UniFFI exposes Uint8Array<ArrayBufferLike>; browser WASM
                // buffers are ordinary ArrayBuffers, matching RTCDataChannel.
                this.channel.send(data as ArrayBufferView<ArrayBuffer>)
            }
        } catch (error) {
            const now = Date.now()
            if (now - this.lastChannelSendFailureAt >= 5000) {
                this.lastChannelSendFailureAt = now
                this.logger?.debug(`control data channel temporarily unwritable: ${error}`)
            }
        }
    }
}
