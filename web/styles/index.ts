import { globalDefaultSettings, getLocalStreamSettings } from "../component/settings_menu"

// old doesn't exist anymore and is always replaced with moonlight when loading the settings
import standardUrl from "./standard.css";
import moonlightUrl from "./moonlight.css";
import pawpadoLaunchUrl from "./pawpado-launch.css";

// Scoped to `.pw-game-launch`, so it is safe on every page and independent
// of the member's selected Moonlight/standard skin.
pawpadoLaunchUrl.use()

export type PageStyle = "standard" | "old" | "moonlight";

let currentStyle: PageStyle | null = null

const styleMap: Record<PageStyle, LazyStyleModule> = {
    standard: standardUrl,
    old: standardUrl,
    moonlight: moonlightUrl
};

export function setStyle(style: PageStyle) {
    if (currentStyle && currentStyle != style) {
        styleMap[currentStyle].unuse()
    }

    styleMap[style].use()
    currentStyle = style
}

export function getStyle(): PageStyle {
    return currentStyle as PageStyle
}

const settings = getLocalStreamSettings(globalDefaultSettings())

setStyle(settings.pageStyle)
