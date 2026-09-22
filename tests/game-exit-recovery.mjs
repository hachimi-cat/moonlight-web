import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real WebRTC watchdog at its await boundaries. A confirmed
// exit during getStats/createOffer must not restart ICE or rearm a timer.
const code = ts.transpileModule(fs.readFileSync('web/stream/transport/webrtc.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fixture() {
  let patches = 0, locals = 0;
  const timers = new Map();
  let id = 0;
  const logs = [];
  const peer = {
    connectionState: 'connected',
    addEventListener() {}, createDataChannel() {}, addTransceiver() {},
    async createOffer() { return { type: 'offer', sdp: 'offer' }; },
    async setLocalDescription() { locals++; },
    async setRemoteDescription() {},
  };
  const util = { globalObject: () => ({
    setInterval(fn) { const key = ++id; timers.set(key, fn); return key; },
    clearInterval(key) { timers.delete(key); }, clearTimeout() {},
  }) };
  const api = { fetchApi: async () => { patches++; return { text: async () => 'answer' }; } };
  const bindings = { InputBatcher: class {} };
  const context = vm.createContext({ exports: {}, console, Date, Map,
    document: { visibilityState: 'visible' },
    RTCPeerConnection: function () { return peer; },
    require: name => name === '../../api' ? api : name === '../../util' ? util : name.includes('moonlight_common_bindings') ? bindings : {},
  });
  vm.runInContext(code, context);
  const subject = new context.exports.WebRTCTransport({}, { iceServers: [] }, { debug: (line) => logs.push(line) }, true);
  subject.location = '/api/stream/webrtc/1';
  return { subject, peer, timers, logs, counts: () => ({ patches, locals }) };
}
{
  const f = fixture();
  let finishStats;
  f.peer.getStats = () => new Promise(resolve => { finishStats = resolve; });
  f.subject.mediaReceived = true;
  f.subject.lastMediaPacketCount = 10;
  f.subject.lastMediaProgressAt = 1;
  f.subject.lastVideoFramesDecoded = 1;
  f.subject.lastVideoFrameProgressAt = 1;
  let recoveryCalls = 0;
  f.subject.closeForRecovery = async () => { recoveryCalls++; };
  const pending = f.subject.checkMediaProgress();
  f.subject.suspendRecovery();
  finishStats(new Map([['video', { type: 'inbound-rtp', kind: 'video', packetsReceived: 10, framesDecoded: 1 }]]));
  await pending;
  assert.equal(recoveryCalls, 0);
  assert.equal(f.timers.size, 0);
  console.log('PASS exit-during-pending-media-stats');
}
{
  const f = fixture();
  let finishOffer;
  f.peer.createOffer = () => new Promise(resolve => { finishOffer = resolve; });
  const pending = f.subject.restartIceInPlace('stalled');
  f.subject.suspendRecovery();
  finishOffer({ type: 'offer', sdp: 'offer' });
  await pending;
  assert.deepEqual(f.counts(), { patches: 0, locals: 0 });
  assert.equal(f.timers.size, 0);
  assert.ok(!f.logs.some(line => line.includes('restart completed')));
  console.log('PASS exit-during-pending-ice-offer');
}
{
  const f = fixture();
  await f.subject.restartIceInPlace('stalled');
  assert.deepEqual(f.counts(), { patches: 1, locals: 1 });
  assert.equal(f.timers.size, 1);
  assert.ok(f.logs.some(line => line.includes('restart completed')));
  console.log('PASS genuine-media-stall-still-recovers');
}
