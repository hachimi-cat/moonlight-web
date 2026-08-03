import * as React from "react"
import { createRoot, type Root } from "react-dom/client"

import { ComponentEvent } from "../component/index"
import { ElementWithLabel } from "../component/element_with_label"
import { type InputInit, type InputChangeListener } from "../component/input"
import { Input } from "./components/input"
import { Slider } from "./components/slider"
import { Switch } from "./components/switch"
import "./tailwind.tw.css"

/*
 * Drop-in replacement for the vanilla `InputComponent`.
 *
 * That class is one component covering several controls — checkbox, number,
 * number-with-slider, text, password, file — plus an optional "enable"
 * checkbox that disables the control next to it. All of it has to keep
 * working, because the settings menu alone builds 11 checkboxes and 8 number
 * fields through this one constructor.
 *
 * Mapping:
 *   checkbox            -> Radix Switch
 *   number + slider     -> styled input + Radix Slider, kept in sync
 *   number              -> styled input
 *   file                -> styled NATIVE input; the OS picker cannot be
 *                          replaced, only the button around it
 *   everything else     -> styled input
 *
 * Public surface matches the vanilla class exactly so call sites only swap
 * the import.
 */

type State = {
    value: string
    checked: boolean
    enabled: boolean
    placeholder: string
}

export class ShadcnInputComponent extends ElementWithLabel {
    private type: string
    private init?: InputInit

    private state: State
    private files: FileList | null = null

    private host: HTMLDivElement = document.createElement("div")
    private root: Root

    constructor(internalName: string, type: string, displayName?: string, init?: InputInit) {
        super(internalName, displayName)

        if (init?.numberSlider && type != "number") {
            throw "tried to create InputComponent with number slider but type wasn't number"
        }

        this.type = type
        this.init = init

        this.state = {
            value: init?.value ?? init?.defaultValue ?? "",
            checked: init?.checked ?? false,
            // Matches the vanilla behaviour: an enable-checkbox starts OFF and
            // the control it guards starts disabled.
            enabled: init?.hasEnableCheckbox ? false : true,
            placeholder: init?.placeholer ?? "",
        }

        this.div.classList.add("pw-root")
        this.div.appendChild(this.host)

        this.root = createRoot(this.host)
        this.render()
    }

    private dispatchChange() {
        this.div.dispatchEvent(new ComponentEvent("ml-change", this))
    }

    private set(patch: Partial<State>, notify: boolean) {
        this.state = { ...this.state, ...patch }
        this.render()
        if (notify) this.dispatchChange()
    }

    private render() {
        const { value, checked, enabled, placeholder } = this.state
        const slider = this.init?.numberSlider
        const step = this.init?.step ? Number(this.init.step) : 1

        const enableSwitch = this.init?.hasEnableCheckbox ? (
            <Switch
                checked={enabled}
                onCheckedChange={(next) => this.set({ enabled: next }, true)}
                aria-label="Enable"
            />
        ) : null

        let control: React.ReactNode

        if (this.type === "checkbox") {
            control = (
                <Switch
                    checked={checked}
                    disabled={!enabled}
                    onCheckedChange={(next) => this.set({ checked: next }, true)}
                />
            )
        } else if (this.type === "number" && slider) {
            const numeric = Number(value)
            control = (
                <div className="flex w-full items-center gap-3">
                    <Slider
                        className="flex-1"
                        min={slider.range_min}
                        max={slider.range_max}
                        step={step}
                        disabled={!enabled}
                        value={[Number.isFinite(numeric) ? numeric : slider.range_min]}
                        onValueChange={([next]) => this.set({ value: String(next) }, false)}
                        onValueCommit={([next]) => this.set({ value: String(next) }, true)}
                    />
                    <Input
                        type="number"
                        className="w-20 shrink-0"
                        min={slider.range_min}
                        max={slider.range_max}
                        step={step}
                        disabled={!enabled}
                        value={value}
                        placeholder={placeholder}
                        onChange={(e) => this.set({ value: e.target.value }, false)}
                        onBlur={() => this.dispatchChange()}
                    />
                </div>
            )
        } else if (this.type === "file") {
            control = (
                <Input
                    type="file"
                    accept={this.init?.accept}
                    disabled={!enabled}
                    onChange={(e) => {
                        this.files = e.target.files
                        this.set({ value: e.target.value }, true)
                    }}
                />
            )
        } else {
            control = (
                <Input
                    type={this.type}
                    inputMode={this.init?.inputMode as React.HTMLAttributes<HTMLInputElement>["inputMode"]}
                    step={this.init?.step}
                    required={this.init?.formRequired}
                    disabled={!enabled}
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => this.set({ value: e.target.value }, false)}
                    onBlur={() => this.dispatchChange()}
                />
            )
        }

        this.root.render(
            <div className="flex w-full items-center gap-3">
                {enableSwitch}
                <div className={this.type === "checkbox" ? "" : "flex-1"}>{control}</div>
            </div>,
        )
    }

    override unmount(parent: HTMLElement): void {
        // See ShadcnSelectComponent: React 19 needs the root torn down before
        // the container leaves the DOM, and not synchronously from an event.
        const root = this.root
        queueMicrotask(() => root.unmount())
        super.unmount(parent)
    }

    reset() {
        this.set({ value: "" }, false)
    }

    setValue(value: string) {
        this.set({ value }, false)
    }
    getValue(): string {
        // Fidelity with the DOM the vanilla component wrapped: a checkbox
        // input's `.value` is "on" unless a value attribute was set, and it
        // does NOT vary with checked state. Callers read checkboxes through
        // isChecked(); this only matters for anything that reads generically.
        if (this.type === "checkbox" && this.state.value === "") {
            return "on"
        }
        return this.state.value
    }

    setChecked(checked: boolean) {
        this.set({ checked }, false)
    }
    isChecked(): boolean {
        return this.state.checked
    }

    getFiles(): FileList | null {
        return this.files
    }

    setEnabled(enabled: boolean) {
        this.set({ enabled }, false)
    }
    isEnabled(): boolean {
        return this.state.enabled
    }

    setPlaceholder(newPlaceholder: string) {
        this.set({ placeholder: newPlaceholder }, false)
    }

    addChangeListener(listener: InputChangeListener, options?: AddEventListenerOptions) {
        this.div.addEventListener("ml-change", listener as any, options)
    }
    removeChangeListener(listener: InputChangeListener) {
        this.div.removeEventListener("ml-change", listener as any)
    }
}
