import { Component } from "./index"

/*
 * Extracted from ./input.ts to break an import cycle.
 *
 * input.ts imports settings_menu.ts (for getLocalStreamSettings), and
 * settings_menu.ts imports the React-backed controls in web/ui, which extend
 * this base class. With the class still declared in input.ts that cycle is
 * input -> settings_menu -> ui -> input, and the `extends` clause runs while
 * input.ts is mid-evaluation:
 *
 *     ReferenceError: Cannot access 'ElementWithLabel' before initialization
 *
 * This module imports nothing but the Component type, so it can sit at the
 * bottom of the graph and be reached from either side. input.ts re-exports it
 * for compatibility.
 */
export class ElementWithLabel implements Component {
    protected div: HTMLDivElement = document.createElement("div")
    protected label: HTMLLabelElement = document.createElement("label")

    constructor(internalName: string, displayName?: string) {
        if (displayName) {
            this.label.htmlFor = internalName
            this.label.innerText = displayName
            this.div.appendChild(this.label)
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }

    mountBefore(parent: HTMLElement, before: ElementWithLabel): void {
        parent.insertBefore(this.div, before.div)
    }
}
