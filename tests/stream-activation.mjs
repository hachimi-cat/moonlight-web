import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

for (const [engine, kind] of [[webkit, 'trackpad'], [webkit, 'touch'], [webkit, 'keyboard'], [chromium, 'mouse']]) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ hasTouch: engine === webkit,
      userAgent: engine === webkit ? 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' : undefined });
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
    await page.goto('http://127.0.0.1:3999/stream.html?hostId=1&appId=2&pawpadoGame=bioshock-infinite&pawpadoGameTitle=BioShock&pawpadoPointerLock=1');
    await page.waitForFunction(() => Boolean(window.app));
    if (process.env.PAWPADO_STREAM_SKIN) await page.addStyleTag({ content: fs.readFileSync(process.env.PAWPADO_STREAM_SKIN, 'utf8') });
    await page.evaluate(() => {
      const app = window.app;
      document.querySelector('.pw-game-launch').style.display = 'none';
      app.fullscreenOnNextInteractionArmed = false;
      Object.defineProperty(document.getElementById('input'), 'requestPointerLock', { value: undefined, configurable: true });
      window.counts = { down: 0, up: 0, audio: 0, fullscreen: 0 };
      app.stream.getInput().onMouseDown = () => window.counts.down++;
      app.stream.getInput().onMouseUp = () => window.counts.up++;
      app.stream.getAudioPlayer = () => ({ onUserInteraction: () => { window.counts.audio++; return Promise.resolve(); } });
    });
    await page.mouse.click(400, 350);
    assert.deepEqual(await page.evaluate(() => [window.counts.down, window.counts.up]), [1, 1], `${kind}: unsupported pointer lock must not swallow mouse/trackpad down`);

    if (engine === webkit) {
      await page.evaluate(() => {
        const app = window.app;
        document.querySelector('.pw-game-launch').style.removeProperty('display');
        Object.defineProperty(navigator, 'getGamepads', { value: () => [{ connected: true, index: 0 }], configurable: true });
        app.launchOverlay.mount(document.body);
        app.waitForMatchingGameProcess = () => new Promise(r => { window.gameReady = r; });
        app.waitForFreshVideoFrame = () => new Promise(r => { window.frameReady = r; });
        app.requestFullscreen = async () => { window.counts.fullscreen++; app.isFullscreen = () => true; };
        app.fullscreenOnNextInteractionArmed = true;
        window.finishLaunch = app.finishDirectGameLaunch();
      });
      const play = page.getByRole('button', { name: 'Enable sound and continue', exact: true });
      await page.waitForTimeout(600);
      assert.equal(await play.isVisible(), false, 'No misleading sound activation before game readiness');
      await page.evaluate(() => window.gameReady());
      await page.waitForFunction(() => typeof window.frameReady === 'function');
      assert.equal(await play.isVisible(), false, 'Process readiness alone cannot reveal sound gate');
      await page.evaluate(() => window.frameReady());
      await play.waitFor({ state: 'visible' });
      const sizes = await page.evaluate(() => {
        const root = document.querySelector('.pw-game-launch');
        const primary = root.querySelector('.pw-game-launch-button-primary');
        const cancel = root.querySelector('a');
        const metrics = el => { const css = getComputedStyle(el); return [el.getBoundingClientRect().height, css.fontSize, css.paddingTop, css.paddingBottom, css.paddingLeft, css.paddingRight]; };
        return [metrics(primary), metrics(cancel)];
      });
      assert.deepEqual(sizes[0], sizes[1], 'Primary and Cancel use identical sizing with the production skin');
      await page.evaluate(() => { window.app.stream.getAudioPlayer = () => ({ onUserInteraction: () => Promise.reject(new Error('blocked')) }); });
      const activate = async () => {
        if (kind === 'touch') await play.tap();
        else if (kind === 'keyboard') { await play.focus(); await page.keyboard.press('Enter'); }
        else await play.click();
      };
      await activate();
      await page.getByText('Sound could not start. Click or tap to try again.').waitFor();
      assert.equal(await play.isVisible(), true, 'Rejected activation must not dismiss loading');
      await page.evaluate(() => { window.app.stream.getAudioPlayer = () => ({ onUserInteraction: () => { window.counts.audio++; return Promise.resolve(); } }); });
      await activate();
      await page.waitForFunction(() => !window.app.launchOverlay.isVisible());
      assert.ok((await page.evaluate(() => window.counts)).audio > 0);
      assert.equal((await page.evaluate(() => window.counts)).fullscreen, 1);
    }
    console.log(`PASS activation ${kind}`);
  } finally { await browser.close(); }
}
