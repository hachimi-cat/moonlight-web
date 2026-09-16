import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the real control adapter with deterministic timers and a fake
// UniFFI boundary. The Rust lifecycle suite separately exercises real ENet.
const source = fs.readFileSync("web/stream/transport/webrtc.ts", "utf8");
const adapter = source.slice(source.indexOf("class WebRtcControlStream"));
const code = ts.transpileModule(adapter + "\nglobalThis.Subject = WebRtcControlStream", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture() {
    const timers = new Map();
    const streams = [];
    let nextTimer = 0;
    class FakeStream {
        events = []; failTimeout = false; failReceive = false; destroyed = false;
        constructor() { streams.push(this); }
        handleTimeout() { if (this.failTimeout) throw Error("NotConnected"); }
        handleReceive() { if (this.failReceive) throw Error("NotConnected"); }
        pollPacket() { return undefined; }
        pollEvent() { return this.events.shift(); }
        pollTimeout() { return 50n; }
        sendRaw() {}
        estimatedRtt() { return { rtt: 30, rttVariance: 2 }; }
        uniffiDestroy() { this.destroyed = true; }
    }
    const channel = {
        readyState: "open", listeners: new Map(), sent: 0,
        addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); },
        removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); },
        send() { this.sent++; },
    };
    const clock = {
        setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    const context = vm.createContext({
        ControlStream: FakeStream, InputBatcher: class { batchInput() { return []; } removeBatchedInputs() { return []; } },
        ControlStreamEvent_Tags: { Connect: "Connect", Disconnect: "Disconnect", Packet: "Packet" },
        globalObject: () => clock, uniffiNow: () => 0n, uniffiMillisUntil: () => 50,
        ENET_IP: "192.168.178.2:47999", console, Date, ArrayBuffer,
    });
    vm.runInContext(code, context);
    const subject = new context.Subject();
    subject.setChannel(channel, "enet", { serverVersion: {} });
    const tick = () => {
        const [id, fn] = timers.entries().next().value;
        timers.delete(id); fn();
    };
    return { subject, channel, streams, timers, tick };
}

for (const fault of ["timeout", "receive", "disconnect"]) {
    const f = fixture();
    if (fault === "timeout") {
        f.streams[0].failTimeout = true;
        assert.doesNotThrow(() => f.tick(), "a protocol timeout must not kill the adapter timer");
    } else if (fault === "receive") {
        f.streams[0].failReceive = true;
        assert.doesNotThrow(() => f.subject.onMessage({ data: new ArrayBuffer(0) }));
    } else {
        f.streams[0].events.push({ tag: "Disconnect" });
        f.tick();
    }
    assert.equal(f.timers.size, 1, "only one recovery timer may be live");
    f.tick();
    assert.equal(f.streams.length, 2, "reconstruct the ENet client, not the WebRTC/Moonlight session");
    assert.equal(f.subject.channel, f.channel, "the existing data channel must survive");
    assert.equal(f.streams[0].destroyed, true);
    assert.equal(f.timers.size, 1, "the replacement control pump must keep running");
    assert.equal(f.channel.listeners.get("message").size, 1);
    f.streams[1].events.push({ tag: "Connect" });
    f.tick();
    assert.equal(f.subject.enetConnected, true, "the repaired control connection becomes active");
    f.subject.setChannel(null);
    assert.equal(f.timers.size, 0);
    assert.equal(f.channel.listeners.get("message").size, 0);
    console.log(`PASS control-${fault}-recovery`);
}
