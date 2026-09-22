import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

// Real bundled ViewerApp, with only the remote host/media simulated.
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    let launch = { slug: 'cyberpunk-2077', title: 'Cyberpunk 2077', launchId: 'old', state: 'exited', updatedAt: 1, message: null };
    let unavailable = false;
    await page.route('http://127.0.0.1:3999/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/authenticate') return route.fulfill({ status: 204 });
      if (pathname === '/api/role') return route.fulfill({ json: { role: { id: 1, name: 'test', ty: 'User', default_settings: {}, permissions: { allow_transport_webrtc: true, allow_transport_websockets: true, allow_codec_h264: true, allow_codec_h265: false, allow_codec_av1: false, maximum_bitrate_kbps: null } } } });
      if (pathname === '/api/launch-state') return unavailable ? route.fulfill({ status: 503 }) : route.fulfill({ json: launch });
      if (pathname === '/api/host') return route.fulfill({ json: { host: { current_game: 2, server_state: 'online' } } });
      if (pathname === '/config.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.__RUNTIME_CONFIG__={path_prefix:""}' });
      const file = path.join(path.resolve(process.env.PAWPADO_TEST_DIST || 'dist'), pathname);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file, contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.wasm') ? 'application/wasm' : undefined });
      return route.fulfill({ status: 503 });
    });
    const reset = async () => {
      await page.goto('http://127.0.0.1:3999/stream.html?hostId=1&appId=2&autoclose=1&pawpadoGame=cyberpunk-2077&pawpadoGameTitle=Cyberpunk%202077');
      await page.waitForFunction(() => Boolean(window.app));
      await page.evaluate(() => {
        const app = window.app;
        app.stream.eventTarget = new EventTarget();
        app.activeDirectLaunchId = 'current';
        app.launchStateBaseline = { launchId: 'old', updatedAt: 1 };
        window.close = () => { window.closedCalls++; };
        window.closedCalls = 0;
        window.pollDone = false;
        window.pollError = null;
      });
    };
    await reset();
    launch = { ...launch, launchId: 'current', state: 'failed', updatedAt: 2, message: 'The game did not open a window within 180 seconds. Cancel or retry from your library.' };
    await page.evaluate(() => window.app.onInfo({ detail: { type: 'streamEnded', graceful: false } }));
    assert.ok((await page.locator('body').innerText()).includes(launch.message), 'launcher timeout must survive transport teardown');
    assert.equal(await page.getByText('Connection to the machine was lost', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.closedCalls), 0);
    console.log(`PASS ${engine.name()}-launch-failure-survives-transport-end`);

    await reset();
    await page.evaluate(() => window.app.onInfo({ detail: { type: 'streamEnded', graceful: true } }));
    await page.getByText(launch.message, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.closedCalls), 0, 'graceful transport is not proof of a successful game launch');
    console.log(`PASS ${engine.name()}-failed-launch-is-not-normal-exit`);

    await reset();
    launch = { ...launch, state: 'starting', updatedAt: 3, message: 'Still opening the game — 90 seconds elapsed. First launches can take longer.' };
    await page.evaluate(() => {
      const realNow = Date.now;
      window.advanceLaunchClock = milliseconds => { Date.now = () => realNow() + milliseconds; };
      window.app.launchOverlay.waitForController = () => Promise.resolve();
      window.app.waitForFreshVideoFrame = async () => { window.frameChecks = (window.frameChecks || 0) + 1; };
      window.launchWork = window.app.finishDirectGameLaunch().then(() => { window.pollDone = true; });
    });
    await page.getByText(launch.message, { exact: true }).waitFor();
    await page.evaluate(() => window.advanceLaunchClock(90_000));
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.pollDone), false, 'healthy launch beyond old 75-second browser deadline remains covered');
    await page.evaluate(() => window.app.finishReconnectOverlay());
    assert.equal(await page.evaluate(() => window.frameChecks || 0), 0, 'recovery must not uncover a game that has not opened yet');
    launch = { ...launch, state: 'running', updatedAt: 4 };
    await page.waitForFunction(() => window.pollDone);
    assert.equal(await page.evaluate(() => window.frameChecks), 1);
    await page.waitForFunction(() => !window.app.launchOverlay.isVisible());
    console.log(`PASS ${engine.name()}-slow-launch-waits-for-window-and-fresh-frame`);

    // A crash is immediate; a later missing API must not replace its reason.
    await reset();
    launch = { ...launch, state: 'failed', updatedAt: 5, message: 'The game exited before its window appeared (code 42)' };
    await page.evaluate(() => { window.app.launchOverlay.waitForController = () => Promise.resolve(); return window.app.finishDirectGameLaunch(); });
    unavailable = true;
    await page.evaluate(() => window.app.onInfo({ detail: { type: 'streamEnded', graceful: false } }));
    await page.getByText(launch.message, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.closedCalls), 0);
    unavailable = false;
    console.log(`PASS ${engine.name()}-crash-reason-latched-across-unreachable-host`);

    // A failed record from another invocation must not be attributed here.
    await reset();
    launch = { ...launch, launchId: 'old', updatedAt: 6 };
    await page.evaluate(() => { window.app.shouldAutoClose = async () => false; return window.app.onInfo({ detail: { type: 'streamEnded', graceful: false } }); });
    await page.getByText('Connection to the machine was lost', { exact: true }).waitFor();
    assert.equal(await page.getByText(launch.message, { exact: true }).count(), 0);
    console.log(`PASS ${engine.name()}-stale-launch-failure-is-not-current`);

    await reset();
    launch = { ...launch, launchId: 'current', state: 'starting', updatedAt: 7, message: 'Waiting for the game window' };
    await page.evaluate(() => {
      window.pendingLaunch = window.app.waitForMatchingGameProcess().catch(() => {}).finally(() => { window.pollDone = true; });
    });
    await page.getByText(launch.message, { exact: true }).waitFor();
    await page.evaluate(() => { window.app.cancelAndReturnToLibrary(); });
    await page.waitForFunction(() => window.pollDone, null, { timeout: 2000 });
    console.log(`PASS ${engine.name()}-cancel-stops-pending-launch-poll`);

    await reset();
    await page.evaluate(() => {
      const realNow = Date.now;
      window.expireLaunch = () => { Date.now = () => realNow() + 241_000; };
      window.pendingLaunch = window.app.waitForMatchingGameProcess().catch(error => { window.pollError = error.message; }).finally(() => { window.pollDone = true; });
    });
    await page.getByText(launch.message, { exact: true }).waitFor();
    await page.evaluate(() => window.expireLaunch());
    await page.waitForFunction(() => window.pollDone, null, { timeout: 2000 });
    assert.match(await page.evaluate(() => window.pollError), /did not finish opening in time/);
    console.log(`PASS ${engine.name()}-launch-wait-remains-bounded`);
  } finally {
    await browser.close();
  }
}
