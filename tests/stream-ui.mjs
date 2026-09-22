import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit } from "playwright";

// Exercise the bundled ViewerApp, not just an isolated overlay. Document's
// fullscreen/remote-input handlers caused the original compatibility-mouse bug.
const dist = path.resolve("dist");
for (const scenario of ["mouse-fullscreen", "mouse-pointer-lock", "keyboard", "stalled-cancel", "touch-webkit", "toast-mouse", "toast-touch-webkit"]) {
    const browser = await (scenario.endsWith("webkit") ? webkit : chromium).launch();
    try {
        const context = await browser.newContext({ hasTouch: scenario.includes("touch") });
        const page = await context.newPage();
        let fullscreen = 0, pointerLock = 0, cancellations = 0;
        await page.exposeFunction("reportFullscreen", () => fullscreen++);
        await page.exposeFunction("reportPointerLock", () => pointerLock++);
        await page.route("http://127.0.0.1:3999/**", async route => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === "/api/authenticate") return route.fulfill({ status: 204 });
            if (pathname === "/api/role") return route.fulfill({ json: { role: {
                id: 1, name: "test", ty: "User", default_settings: {}, permissions: {
                    allow_transport_webrtc: true, allow_transport_websockets: true,
                    allow_codec_h264: true, allow_codec_h265: false, allow_codec_av1: false,
                    maximum_bitrate_kbps: null,
                },
            } } });
            if (pathname === "/api/pawpado/launch-state") return route.fulfill({ json: null });
            if (pathname.includes("cancel")) {
                cancellations++;
                if (scenario === "stalled-cancel") return; // deliberately never complete cleanup
                return route.fulfill({ json: {} });
            }
            if (pathname === "/dashboard/games") return route.fulfill({ body: "LIBRARY" });
            if (pathname === "/config.js") return route.fulfill({
                contentType: "application/javascript", body: 'window.__RUNTIME_CONFIG__={path_prefix:""}',
            });
            const file = path.join(dist, pathname);
            if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({
                path: file,
                contentType: pathname.endsWith(".wasm") ? "application/wasm" :
                    pathname.endsWith(".js") ? "application/javascript" :
                        pathname.endsWith(".html") ? "text/html" : undefined,
            });
            return route.fulfill({ status: 503, body: "stream deliberately unavailable" });
        });
        await page.goto("http://127.0.0.1:3999/stream.html?hostId=1&appId=2&pawpadoGame=bioshock-infinite&pawpadoGameTitle=BioShock&pawpadoPointerLock=1");
        await page.waitForFunction(() => Boolean(window.app));
        await page.evaluate(scenario => {
            window.close = () => {}; // normal tab: verify the native-link fallback
            // The unavailable fake host must not replace our deliberately
            // failed UI state with an unrelated background reconnect.
            window.app.stream.eventTarget = new EventTarget();
            window.app.requestFullscreen = async () => window.reportFullscreen();
            window.app.requestPointerLock = async () => window.reportPointerLock();
            window.app.fullscreenOnNextInteractionArmed = scenario !== "mouse-pointer-lock";
            window.app.launchOverlay.fail("Test connection failure", "Cleanup may be unavailable");
        }, scenario);
        if (scenario.startsWith("toast-")) {
            await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", {
                error: new Error("Synthetic transport error"),
            })));
            const toast = page.getByRole("alert").filter({ hasText: "Synthetic transport error" });
            const dismiss = toast.getByRole("button", { name: "Dismiss" });
            if (scenario.includes("touch")) await dismiss.tap();
            else await dismiss.click();
            await toast.waitFor({ state: "detached" });
            assert.equal(fullscreen, 0, "dismissing an error must not trigger fullscreen");
            assert.equal(pointerLock, 0, "dismissing an error must not capture the pointer");
        }
        const leave = page.getByRole("link", { name: "Back to library" });
        if (scenario === "keyboard") {
            await leave.focus();
            await page.keyboard.press("Enter");
        } else if (scenario.includes("touch")) {
            await leave.tap();
        } else {
            await leave.click();
        }
        await page.waitForURL("http://127.0.0.1:3999/dashboard/games");
        assert.ok(cancellations > 0, "cancel must be attempted without blocking navigation");
        assert.equal(fullscreen, 0, "local UI must not trigger stream fullscreen");
        assert.equal(pointerLock, 0, "local UI must not trigger stream pointer lock");
        console.log(`PASS ${scenario}`);
    } finally {
        await browser.close();
    }
}
