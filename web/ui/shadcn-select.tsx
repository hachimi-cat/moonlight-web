import * as React from "react"
import { createRoot, type Root } from "react-dom/client"

import { ComponentEvent } from "../component/index"
import { ElementWithLabel } from "../component/element_with_label"
import { type SelectInit, type InputChangeListener } from "../component/input"
import { getCurrentLanguage, getTranslations } from "../i18n"
import { styleControlLabel } from "./lib/label"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "./components/select"
import "./tailwind.tw.css"

/*
 * A drop-in replacement for the vanilla `SelectComponent`, backed by Radix.
 *
 * It deliberately mirrors the vanilla class's public surface exactly —
 * mount/unmount/mountBefore/getValue/reset/setOptionEnabled/addChangeListener
 * and the same `ml-change` ComponentEvent on the same wrapper div — so call
 * sites swap the import and nothing else. That is what keeps this fork's
 * divergence from upstream small enough to rebase.
 *
 * Rendering is a React island: one root per instance, mounted into the same
 * `this.div` that the vanilla component would have used.
 */

type Option = { value: string; name: string }

function SelectIsland(props: {
    options: Array<Option>
    value: string
    disabled: ReadonlySet<string>
    placeholder: string
    onChange: (value: string) => void
}) {
    const { options, value, disabled, placeholder, onChange } = props

    return (
        <Select value={value === "" ? undefined : value} onValueChange={onChange}>
            <SelectTrigger aria-label={placeholder}>
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={disabled.has(option.value)}
                    >
                        {option.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

export class ShadcnSelectComponent extends ElementWithLabel {
    private options: Array<Option>
    private preSelectedOption: string
    private value: string
    private disabled: Set<string> = new Set()

    private host: HTMLDivElement = document.createElement("div")
    private root: Root

    constructor(internalName: string, options: Array<Option>, init?: SelectInit) {
        super(internalName, init?.displayName)

        this.options = options
        this.preSelectedOption = init?.preSelectedOption ?? ""
        this.value = this.preSelectedOption

        this.div.classList.add("pw-root", "mb-3")
        styleControlLabel(this.label)
        this.host.classList.add("pw-select")
        this.div.appendChild(this.host)

        this.root = createRoot(this.host)
        this.render()
    }

    private render() {
        const i = getTranslations(getCurrentLanguage()).common

        this.root.render(
            <SelectIsland
                options={this.options}
                value={this.value}
                disabled={this.disabled}
                placeholder={i.notSelected}
                onChange={(next) => {
                    this.value = next
                    this.render()
                    this.dispatchChange()
                }}
            />,
        )
    }

    private dispatchChange() {
        this.div.dispatchEvent(new ComponentEvent("ml-change", this))
    }

    override unmount(parent: HTMLElement): void {
        // React 19 warns (and leaks the root) if a container is removed from
        // the DOM while its root is still mounted. Unmount before detaching,
        // and defer it: calling root.unmount() synchronously from inside a
        // React event handler throws.
        const root = this.root
        queueMicrotask(() => root.unmount())
        super.unmount(parent)
    }

    reset() {
        this.value = this.preSelectedOption
        this.render()
    }

    getValue(): string | null {
        return this.value
    }

    setOptionEnabled(value: string, enabled: boolean) {
        if (enabled) {
            this.disabled.delete(value)
        } else {
            this.disabled.add(value)
        }
        this.render()
    }

    addChangeListener(listener: InputChangeListener, options?: AddEventListenerOptions) {
        this.div.addEventListener("ml-change", listener as any, options)
    }
    removeChangeListener(listener: InputChangeListener) {
        this.div.removeEventListener("ml-change", listener as any)
    }
}
