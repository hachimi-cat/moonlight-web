/** Keep local UI gestures out of the document-level remote-input handlers.
 * A desktop pointer also emits mousedown/mouseup: blocking pointerdown alone
 * does not stop those compatibility events from triggering fullscreen/lock.
 * Do not preventDefault here; links, keyboard activation and scrolling must
 * retain their native behaviour even if stream cleanup is stalled.
 */
export function stopPropagationOn(element: HTMLElement) {
    for (const name of [
        "keydown", "keyup", "keypress", "paste", "click", "dblclick",
        "pointerdown", "pointerup", "pointermove", "pointercancel",
        "mousedown", "mouseup", "mousemove", "wheel", "contextmenu",
        "touchstart", "touchmove", "touchend", "touchcancel",
    ]) {
        element.addEventListener(name, event => event.stopPropagation(), { passive: true })
    }
}
