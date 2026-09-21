import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

// Drive the real bundled ViewerApp and its real launch-state HTTP reads.
// Only media/host endpoints are simulated; no live customer game is stopped.
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    let launch = { slug: 'bioshock-infinite', title: 'BioShock', launchId: 'old', state: 'exited', updatedAt: 1, pid: 42, message: null };
    let appSlot = 2, statusUnavailable = false, cancellations = 0;
    await page.route('http://127.0.0.1:3999/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/authenticate') return route.fulfill({ status: 204 });
      if (pathname === '/api/role') return route.fulfill({ json: { role: { id: 1, name: 'test', ty: 'User', default_settings: {}, permissions: { allow_transport_webrtc: true, allow_transport_websockets: true, allow_codec_h264: true, allow_codec_h265: false, allow_codec_av1: false, maximum_bitrate_kbps: null } } } });
      if (pathname === '/api/launch-state') return statusUnavailable
        ? route.fulfill({ status: 503 }) : route.fulfill({ json: launch });
      if (pathname === '/api/host') return route.fulfill({ json: { host: { current_game: appSlot, server_state: 'online' } } });
      if (pathname.includes('cancel')) { cancellations++; return route.fulfill({ json: {} }); }
      if (pathname === '/config.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.__RUNTIME_CONFIG__={path_prefix:""}' });
      const file = path.join(path.resolve(process.env.PAWPADO_TEST_DIST || 'dist'), pathname);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file, contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.wasm') ? 'application/wasm' : undefined });
      return route.fulfill({ status: 503 });
    });
    await page.goto('http://127.0.0.1:3999/stream.html?hostId=1&appId=2&autoclose=1&pawpadoGame=bioshock-infinite&pawpadoGameTitle=BioShock');
    await page.waitForFunction(() => Boolean(window.app));
    await page.evaluate(() => {
      const app = window.app;
      // Isolate initial fake-host connection failure, retain real ViewerApp handling.
      app.stream.eventTarget = new EventTarget();
      app.stream.addInfoListener(event => void app.onInfo(event));
      app.activeDirectLaunchId = 'current';
      window.closedCalls = 0;
      window.close = () => { window.closedCalls++; };
    });

    launch = { ...launch, launchId: 'current', updatedAt: 2 };
    await page.evaluate(() => { void window.app.onInfo({ detail: { type: 'streamEnded', graceful: true } }); });
    await page.getByText('Closing the game completely…', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.closedCalls), 0, 'wait for Apollo app-slot cleanup before auto-close');
    await page.evaluate(() => window.app.onInfo({ detail: { type: 'addDebugLine', line: 'WebRTC media stalled; restarting ICE without disconnecting the controller', additional: { type: 'recover' } } }));
    assert.equal(await page.getByText('Reconnecting to your game…', { exact: true }).count(), 0, 'late recovery must never replace the confirmed-exit UI');
    appSlot = 0;
    await page.waitForFunction(() => window.closedCalls === 1);
    assert.equal(cancellations, 0, 'normal game exit must not issue a competing Apollo cancel');
    console.log(`PASS ${engine.name()}-exit-wins-over-late-recovery`);

    // New invocation: launch ownership and missing status must not close it.
    launch = { ...launch, launchId: 'old', updatedAt: 3 };
    appSlot = 2;
    await page.evaluate(() => {
      const app = window.app;
      app.streamEnding = false;
      app.pageExitHandled = false;
      app.stream.streamEndedDispatched = false;
      window.closedCalls = 0;
      window.suspended = 0;
      app.stream.transport = { suspendRecovery: () => { window.suspended++; } };
      app.startGameExitWatch();
    });
    await page.waitForTimeout(1250);
    assert.equal(await page.evaluate(() => window.suspended), 0, 'old launch exit is not the current game exit');
    launch = { ...launch, launchId: 'current', state: 'running' };
    await page.waitForTimeout(1250);
    assert.equal(await page.evaluate(() => window.suspended), 0, 'a running game remains recoverable');
    statusUnavailable = true;
    await page.waitForTimeout(1250);
    assert.equal(await page.evaluate(() => window.closedCalls), 0, 'network failure must not auto-close');
    statusUnavailable = false;
    launch = { ...launch, state: 'exited', updatedAt: 4 };
    await page.waitForFunction(() => window.suspended === 1, null, { timeout: 4000 });
    assert.equal(await page.evaluate(() => window.closedCalls), 0, 'confirmed process exit still waits for app-slot release');
    appSlot = 0;
    await page.waitForFunction(() => window.closedCalls === 1);
    assert.equal(await page.evaluate(() => window.app.gameExitWatchTimer), null, 'terminal exit stops lifecycle polling');
    assert.equal(cancellations, 0);
    console.log(`PASS ${engine.name()}-owned-exit-without-termination-packet`);

    // A previously-started frame wait may reject after exit. It must not
    // replace the closing screen with a recovery error.
    await page.evaluate(() => {
      const app = window.app;
      app.streamEnding = false;
      app.pageExitHandled = false;
      app.reconnectOverlayRunning = false;
      app.launchOverlay.showReconnect();
      app.waitForFreshVideoFrame = () => new Promise((_resolve, reject) => { window.failFrame = reject; });
      window.finishingRecovery = app.finishReconnectOverlay();
      app.streamEnding = true;
      app.launchOverlay.showClosing();
      window.failFrame(new Error('late frame timeout'));
    });
    await page.evaluate(() => window.finishingRecovery);
    await page.getByText('Closing the game completely…', { exact: true }).waitFor();
    console.log(`PASS ${engine.name()}-exit-wins-over-pending-frame-wait`);
  } finally {
    await browser.close();
  }
}
