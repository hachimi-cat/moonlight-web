import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

for (const [engine, name] of [[webkit, 'webkit-ipad-desktop-ua'], [chromium, 'chromium-desktop']]) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1194, height: 834 }, hasTouch: engine === webkit,
      userAgent: engine === webkit ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15' : undefined });
    const page = await context.newPage();
    await page.route('http://127.0.0.1:3999/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/authenticate') return route.fulfill({ status: 204 });
      if (pathname === '/api/role') return route.fulfill({ json: { role: { id: 1, name: 'test', ty: 'User', default_settings: {}, permissions: { allow_transport_webrtc: true, allow_transport_websockets: true, allow_codec_h264: true, allow_codec_h265: false, allow_codec_av1: false, maximum_bitrate_kbps: null } } } });
      if (pathname === '/config.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.__RUNTIME_CONFIG__={path_prefix:""}' });
      const file = path.join(path.resolve(process.env.PAWPADO_TEST_DIST || 'dist'), pathname);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file, contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.wasm') ? 'application/wasm' : undefined });
      return route.fulfill({ status: 503 });
    });
    await page.goto('http://127.0.0.1:3999/stream.html?hostId=1&appId=2');
    await page.waitForFunction(() => Boolean(window.app));
    // The fake host never completes connection, so dismiss only its loading
    // modal. The real sidebar and document input handlers remain in use.
    await page.addStyleTag({ content: '#modal-overlay { display: none !important; }' });
    if (process.env.PAWPADO_STREAM_SKIN) await page.addStyleTag({ content: fs.readFileSync(process.env.PAWPADO_STREAM_SKIN, 'utf8') });
    await page.evaluate(() => {
      const app = window.app;
      app.stream.eventTarget = new EventTarget();
      app.fullscreenOnNextInteractionArmed = false;
      app.getStreamRect = () => new DOMRect(0, 0, 120, 120);
      window.inputs = [];
      app.stream.getInput().setControlStream({ send: e => window.inputs.push({ tag: e.tag, ...e.inner }) });
      Object.defineProperty(document.getElementById('input'), 'requestPointerLock', { value: undefined, configurable: true });
      // Fake host only. Keep the real document/input event dispatchers.
      window.sendWheel = (deltaY, deltaMode = 0) => {
        const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, deltaMode });
        document.getElementById('input').dispatchEvent(e);
        return e.defaultPrevented;
      };
    });
    assert.equal(await page.evaluate(() => window.sendWheel(3, 1)), true);
    assert.deepEqual(await page.evaluate(() => window.inputs), [{ tag: 'MouseScrollVertical', scrollY: -120 }]);
    await page.locator('#sidebar-button').click();
    const mode = page.locator('label[for="liveScrollMode"]').locator('..').getByRole('combobox');
    const sensitivity = page.locator('label[for="liveScrollSensitivity"]').locator('..').getByRole('combobox');
    await mode.click();
    await page.getByRole('option', { name: 'Normal', exact: true }).click();
    await sensitivity.click();
    await page.getByRole('option', { name: '2×', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => {
      const { mouseScrollMode, scrollSensitivity } = window.app.getStream().getInput().getConfig();
      return { mouseScrollMode, scrollSensitivity };
    }), { mouseScrollMode: 'normal', scrollSensitivity: 2 });
    const before = await page.evaluate(() => window.inputs.length);
    await page.evaluate(() => {
      const menu = document.querySelector('.sidebar-stream');
      menu.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.evaluate(() => window.inputs.length), before, 'Scrolling settings must not scroll the host');
    await page.evaluate(() => window.sendWheel(30));
    assert.equal(await page.evaluate(() => window.inputs.length), before);
    await page.evaluate(() => window.sendWheel(30));
    assert.equal(await page.evaluate(() => window.inputs.at(-1).scrollY), -120);
    await mode.click();
    await page.getByRole('option', { name: 'High Res', exact: true }).click();
    await page.evaluate(() => window.sendWheel(0.25));
    const count = await page.evaluate(() => window.inputs.length);
    await page.evaluate(() => window.sendWheel(0.25));
    assert.equal(await page.evaluate(() => window.inputs.length), count + 1);
    assert.equal(await page.evaluate(() => window.inputs.at(-1).scrollY), -1);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mlSettings')));
    assert.equal(saved.scrollSensitivity, 2);
    assert.equal(saved.mouseScrollMode, 'highres');
    const diag = await page.evaluate(() => window.app.getStream().getInput().getScrollDiagnostics());
    assert.equal(diag.samples.at(-1).rawY, 0.25);
    assert.equal(diag.samples.at(-1).sentY, -1);
    assert.equal(await page.getByRole('button', { name: /streamed cursor/i }).count(), 0, 'Windows cursor must remain untouched');
    if (process.env.PAWPADO_SCROLL_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PAWPADO_SCROLL_SCREENSHOT_DIR, `${name}.png`) });
    console.log(`PASS real viewer scroll ${name}: unit conversion, live controls, fractional input, local UI isolation, diagnostics`);
  } finally { await browser.close(); }
}
