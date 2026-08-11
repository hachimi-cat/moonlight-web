/**
 * Styling for the <label> that `ElementWithLabel` creates.
 *
 * Applied from the React bridges rather than from the base class, because the
 * base is shared with the remaining vanilla components — restyling it there
 * would reach controls this fork has not converted yet.
 */
export const CONTROL_LABEL_CLASSES = [
    "mb-1.5",
    "block",
    "text-sm",
    "font-normal",
    "text-pw-fg/85",
]

export function styleControlLabel(label: HTMLLabelElement) {
    label.classList.add(...CONTROL_LABEL_CLASSES)
}
