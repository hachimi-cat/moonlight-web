import { ControllerButtons } from "../uniffi/moonlight_common_bindings"
import { deepEqual } from "../util"

export type ControllerConfig = {
    invertXY: boolean
    invertAB: boolean
    multiControllerMode: MultiControllerMode
    sendIntervalOverride: number | null
}

export type MultiControllerMode = "auto" | "single"

export type GamepadLaunchSettings = {
    attachedMask: number
    persistAfterDisconnect: boolean
}

/**
 * Controller state that must be present in the Moonlight launch request.
 *
 * Apollo assigns a GLOBAL virtual-controller id for every controller in each
 * stream's LOCAL mask. Two browser streams may therefore both call their
 * first pad controller 0; Apollo maps them to different XInput devices.
 */
export function gamepadLaunchSettings(
    mode: MultiControllerMode,
    connectedGamepads: number,
): GamepadLaunchSettings {
    if (mode == "single") {
        // Match native Moonlight's Single mode: controller 1 is present even
        // before a physical pad is connected, for games that scan only once.
        return { attachedMask: 1, persistAfterDisconnect: true }
    }

    const count = Math.max(0, Math.min(16, Math.floor(connectedGamepads)))
    const attachedMask = count == 16 ? 0xffff : (1 << count) - 1
    return { attachedMask, persistAfterDisconnect: false }
}

// https://w3c.github.io/gamepad/#remapping
const STANDARD_BUTTONS: Array<keyof ControllerButtons | null> = [
    "b",
    "a",
    "y",
    "x",
    "lb",
    "rb",
    // These are triggers
    null,
    null,
    "back",
    "play",
    "lsClk",
    "rsClk",
    "up",
    "down",
    "left",
    "right",
    "special",
]

export const SUPPORTED_BUTTONS: ControllerButtons = {
    a: true,
    b: true,
    x: true,
    y: true,
    up: true,
    down: true,
    left: true,
    right: true,
    lb: true,
    rb: true,
    play: true,
    back: true,
    lsClk: true,
    rsClk: true,
    special: true,
    paddle1: false,
    paddle2: false,
    paddle3: false,
    paddle4: false,
    touchpad: false,
    misc: false
}


// Nintendo pads report the standard mapping by POSITION, but their labels
// sit swapped relative to Xbox: the button labeled A is where Xbox puts B,
// X where Xbox puts Y. A game showing "Press A" then reads the wrong
// button on every prompt. Vendor 057e is Nintendo's USB id; the name
// checks catch pads (and browsers) that don't expose the vendor id.
const NINTENDO_LAYOUT_ID = /vendor:\s*057e|nintendo|joy-?con|pro controller/i

export function isNintendoLayout(gamepad: Gamepad): boolean {
    return NINTENDO_LAYOUT_ID.test(gamepad.id)
}

// The invert toggles are applied relative to the pad's detected layout —
// an XOR, not an override. OFF therefore means "buttons do what their
// labels say" on every pad, which is the default players expect, and a
// Nintendo player who prefers positional (Xbox-style) mapping still has
// the toggle as an escape hatch.
export function effectiveControllerConfig(gamepad: Gamepad, config: ControllerConfig): ControllerConfig {
    if (!isNintendoLayout(gamepad)) return config
    return { ...config, invertAB: !config.invertAB, invertXY: !config.invertXY }
}

function convertStandardButton(buttonIndex: number, config?: ControllerConfig): keyof ControllerButtons | null {
    let button = STANDARD_BUTTONS[buttonIndex] ?? null

    if (config?.invertAB) {
        if (button == "a") {
            button = "b"
        } else if (button == "b") {
            button = "a"
        }
    }
    if (config?.invertXY) {
        if (button == "x") {
            button = "y"
        } else if (button == "y") {
            button = "x"
        }
    }

    return button
}

export type GamepadState = {
    buttonFlags: ControllerButtons
    leftTrigger: number
    rightTrigger: number
    leftStickX: number
    leftStickY: number
    rightStickX: number
    rightStickY: number
}

export function extractGamepadState(gamepad: Gamepad, config: ControllerConfig): GamepadState {
    const state = emptyGamepadState()
    const effective = effectiveControllerConfig(gamepad, config)

    for (let buttonId = 0; buttonId < gamepad.buttons.length; buttonId++) {
        const button = gamepad.buttons[buttonId]

        const buttonName = convertStandardButton(buttonId, effective)
        if (button.pressed && buttonName !== null) {
            state.buttonFlags[buttonName] = true
        }
    }

    state.leftTrigger = gamepad.buttons[6].value
    state.rightTrigger = gamepad.buttons[7].value

    state.leftStickX = gamepad.axes[0]
    state.leftStickY = gamepad.axes[1]
    state.rightStickX = gamepad.axes[2]
    state.rightStickY = gamepad.axes[3]

    return state
}

export function emptyGamepadState(): GamepadState {
    return {
        buttonFlags: {
            a: false,
            b: false,
            x: false,
            y: false,
            up: false,
            down: false,
            left: false,
            right: false,
            lb: false,
            rb: false,
            play: false,
            back: false,
            lsClk: false,
            rsClk: false,
            special: false,
            paddle1: false,
            paddle2: false,
            paddle3: false,
            paddle4: false,
            touchpad: false,
            misc: false
        },
        leftTrigger: 0,
        rightTrigger: 0,
        leftStickX: 0,
        leftStickY: 0,
        rightStickX: 0,
        rightStickY: 0,
    }
}

export function areGamepadStatesEqual(a: GamepadState, b: GamepadState): boolean {
    return deepEqual(a.buttonFlags, b.buttonFlags)
        && areFloatsEqual(a.leftTrigger, b.leftTrigger)
        && areFloatsEqual(a.rightTrigger, b.rightTrigger)
        && areFloatsEqual(a.leftStickX, b.leftStickX)
        && areFloatsEqual(a.leftStickY, b.leftStickY)
        && areFloatsEqual(a.rightStickX, b.rightStickX)
        && areFloatsEqual(a.rightStickY, b.rightStickY)
}

/** Merge physical pads into Moonlight's single virtual controller. */
export function mergeGamepadStates(states: readonly GamepadState[]): GamepadState {
    const merged = emptyGamepadState()

    for (const state of states) {
        for (const button of Object.keys(merged.buttonFlags) as Array<keyof ControllerButtons>) {
            merged.buttonFlags[button] ||= state.buttonFlags[button]
        }

        merged.leftTrigger = Math.max(merged.leftTrigger, state.leftTrigger)
        merged.rightTrigger = Math.max(merged.rightTrigger, state.rightTrigger)

        if (stickMagnitude(state.leftStickX, state.leftStickY) > stickMagnitude(merged.leftStickX, merged.leftStickY)) {
            merged.leftStickX = state.leftStickX
            merged.leftStickY = state.leftStickY
        }
        if (stickMagnitude(state.rightStickX, state.rightStickY) > stickMagnitude(merged.rightStickX, merged.rightStickY)) {
            merged.rightStickX = state.rightStickX
            merged.rightStickY = state.rightStickY
        }
    }

    return merged
}

function stickMagnitude(x: number, y: number): number {
    return x * x + y * y
}

const FLOAT_COMPARE_MULTIPLIER = 100
function areFloatsEqual(a: number, b: number): boolean {
    return Math.round(a * FLOAT_COMPARE_MULTIPLIER) == Math.round(b * FLOAT_COMPARE_MULTIPLIER)
}
