import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let time = 100;
const wheelContext = { exports: {}, performance: { now: () => time }, Date };
vm.runInNewContext(compile('web/stream/scroll.ts'), wheelContext);
const { WheelScroll, validScrollSensitivity } = wheelContext.exports;
const event = (deltaX, deltaY, deltaMode = 0) => ({ deltaX, deltaY, deltaMode, timeStamp: time, cancelable: true });
const viewport = { width: 120, height: 120 };
for (const [mode, amount] of [[0, 120], [1, 3], [2, 1]]) {
  const wheel = new WheelScroll();
  assert.equal(wheel.take(event(0, amount, mode), viewport, 'highres', 1).y, -120);
}
console.log('PASS pixels/lines/pages normalize to identical host units');
let wheel = new WheelScroll();
let total = 0;
for (let i = 0; i < 8; i++) total += wheel.take(event(0, 0.25), viewport, 'highres', 1).y;
assert.equal(total, -2);
wheel = new WheelScroll();
for (let i = 0; i < 3; i++) assert.equal(wheel.take(event(0, 30), viewport, 'normal', 1).y, 0);
assert.equal(wheel.take(event(0, 30), viewport, 'normal', 1).y, -120);
assert.equal(wheel.take(event(0, 30), viewport, 'highres', 2).y, -60);
console.log('PASS fractional input, whole-notch normal mode, explicit sensitivity');
wheel = new WheelScroll();
wheel.take(event(0, 119), viewport, 'normal', 1);
assert.equal(wheel.take(event(0, -120), viewport, 'normal', 1).y, 120);
wheel.take(event(0, 119), viewport, 'normal', 1);
time += 501;
assert.equal(wheel.take(event(0, 1), viewport, 'normal', 1).y, 0);
wheel.reset();
assert.equal(wheel.take(event(0, 119), viewport, 'normal', 1).y, 0);
console.log('PASS reversal, gesture expiry and reconnect reset');
assert.equal(wheel.take(event(NaN, 1), viewport, 'highres', 1), null);
assert.equal(wheel.take(event(0, 1, 99), viewport, 'highres', 1), null);
assert.equal(validScrollSensitivity(Infinity), 1);
assert.equal(validScrollSensitivity(99), 4);
assert.equal(validScrollSensitivity(0.01), 0.25);
assert.equal(new WheelScroll().take(event(1e20, 1e20), viewport, 'normal', 4).x, 32760);
let modeRead = false;
new WheelScroll().take({ get deltaMode() { modeRead = true; return 0; }, get deltaX() { assert.ok(modeRead); return 0; }, get deltaY() { assert.ok(modeRead); return 1; }, timeStamp: time, cancelable: true }, viewport, 'highres', 1);
for (let i = 0; i < 60; i++) wheel.take(event(0, 1), viewport, 'highres', 1);
const diag = wheel.diagnostics('highres', 1);
assert.equal(diag.samples.length, 32);
assert.equal(diag.samples.at(-1).processingMs, 0);
assert.equal(JSON.stringify(diag).includes('clientX'), false);
console.log('PASS bounds, deltaMode read order, bounded content-free diagnostics');

// Run the real StreamInput class; mock only the native event boundary.
const types = new Proxy({}, { get: (_, tag) => class { constructor(data) { this.tag = tag; Object.assign(this, data); } } });
const inputContext = { exports: {}, EventTarget, performance: { now: () => time }, console,
  require: name => name === './scroll' ? wheelContext.exports : ({ ClientInputEvent: types, emptyGamepadState: () => ({}) }),
};
vm.runInNewContext(compile('web/stream/input.ts'), inputContext);
const input = new inputContext.exports.StreamInput();
const sent = [];
input.setControlStream({ send: e => sent.push(e) });
input.onMouseWheel(event(0, 3, 1), viewport);
assert.equal(sent.length, 1, 'Do not send empty horizontal packets');
assert.equal(sent[0].scrollY, -120);
input.setConfig({ ...input.getConfig(), mouseScrollMode: 'normal', scrollSensitivity: 2 });
input.onMouseWheel(event(0, 30), viewport);
assert.equal(sent.length, 1);
input.onMouseWheel(event(0, 30), viewport);
assert.equal(sent.at(-1).scrollY, -120);
input.onMouseWheel(event(0, 30), viewport);
input.setControlStream({ send: e => sent.push(e) });
input.onMouseWheel(event(0, 30), viewport);
assert.equal(sent.length, 2, 'No pre-reconnect scroll remainder');
assert.equal(input.getScrollDiagnostics().mode, 'normal');
console.log('PASS actual StreamInput wiring, setting changes, no empty packets, reconnect');
