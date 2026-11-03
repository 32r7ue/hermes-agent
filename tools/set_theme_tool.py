"""Set the Hermes desktop app's accent colour, light/dark mode and layout, or show a picker card.

The renderer applies the values and answers with what it applied, so the model reports what the user
sees: an unknown layout preset, a session that is not on screen and an absent desktop window all come
back as errors. Swatch ids and preset ids are validated again in the renderer, which also knows the
user's own saved layouts.
"""

import json
import re
from typing import Callable, Optional

from tools.registry import registry, tool_error

ACCENT_SWATCHES = ("mono", "green", "cyan", "nous", "violet", "pink", "red", "orange")
# The theme's own accent; the renderer stores it as "no accent pick".
THEME_ACCENT = "theme"
MODES = ("light", "dark", "system")
PICKERS = ("accent", "layout")
# The bundled presets (apps/desktop/src/app/contrib/layout-presets.ts). Simple mode shows only the
# first two; applying an Advanced preset switches the app to Advanced mode.
SIMPLE_LAYOUTS = ("sidebar-left", "sidebar-right")
ADVANCED_LAYOUTS = ("default", "basic", "focus", "terminal-deck", "quad")

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _accent_error(accent: str) -> Optional[str]:
    if accent in ACCENT_SWATCHES or accent == THEME_ACCENT or _HEX.match(accent):
        return None
    return json.dumps({"success": False, "error": f"Unknown accent {accent!r}: use a swatch id, 'theme' or #rrggbb.",
                       "available": [*ACCENT_SWATCHES, THEME_ACCENT]}, ensure_ascii=False)


def set_theme_tool(accent: Optional[str] = None, mode: Optional[str] = None, layout: Optional[str] = None,
                   picker: Optional[str] = None, settings: Optional[dict] = None, inspect: bool = False, callback: Optional[Callable[[dict], dict]] = None) -> str:
    """Apply the given appearance values, or show one picker card and wait for the pick."""
    if callback is None:
        return tool_error("set_theme is only available in the Hermes desktop app.")
    values = {key: value.strip() for key, value in (("accent", accent), ("mode", mode), ("layout", layout))
              if isinstance(value, str) and value.strip()}
    if settings is not None:
        if not isinstance(settings, dict):
            return tool_error("settings must be an object. Use inspect=true to list app preferences.")
        values["settings"] = settings
    if inspect:
        values["inspect"] = True
    if picker is not None:
        if picker not in PICKERS:
            return tool_error(f"picker must be one of: {', '.join(PICKERS)}.")
        if values:
            return tool_error("picker shows a card for the user to choose; pass picker alone, without values.")
        return json.dumps(callback({"picker": picker}), ensure_ascii=False)
    if not values:
        return tool_error("Pass appearance values, settings, inspect=true, or picker to let the user choose.")
    if "mode" in values and values["mode"] not in MODES:
        return json.dumps({"success": False, "error": f"Unknown mode {values['mode']!r}.", "available": list(MODES)},
                          ensure_ascii=False)
    if "accent" in values and (error := _accent_error(values["accent"])):
        return error
    return json.dumps(callback(values), ensure_ascii=False)


SET_THEME_SCHEMA = {
    "name": "set_theme",
    "description": (
        "Inspect or change Hermes Desktop settings without computer use. inspect=true lists current app preferences. "
        "settings accepts backdrop (bool), text_scale (90/100/110/125/150/175), interface_mode (simple/advanced), "
        "reasoning_collapsed/statusbar_visible (bool), translucency/translucency_fade (0-100), "
        "translucency_mode (clear/glass), glass_material (under-window/popover/titlebar/header), glass_scope (sidebar/window). "
        "For backend/runtime preferences use hermes config get/set through the terminal tool. "
        "Also change accent colour, light/dark mode and layout. Pass the values "
        "to apply them now; the result says what was applied. Pass picker instead to show the user an "
        "accent or layout picker card in the chat and wait for their pick. To reveal ONE pane, use "
        "focus_pane instead."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "inspect": {"type": "boolean", "description": "Read current app preferences without changing them."},
            "settings": {"type": "object", "description": "Patch app preferences listed above. Unknown keys are rejected before any changes apply."},
            "accent": {
                "type": "string",
                "description": (f"A swatch id ({', '.join(ACCENT_SWATCHES)}), 'theme' for the theme's own "
                                "accent, or a hex colour '#rrggbb'."),
            },
            "mode": {"type": "string", "enum": list(MODES)},
            "layout": {
                "type": "string",
                "description": (f"Layout preset id. Simple mode: {', '.join(SIMPLE_LAYOUTS)}. Advanced mode: "
                                f"{', '.join(ADVANCED_LAYOUTS)}. The user's saved layouts by id."),
            },
            "picker": {
                "type": "string",
                "enum": list(PICKERS),
                "description": "Show that picker card and wait for the user (up to 5 minutes). Pass it alone.",
            },
        },
    },
}


registry.register(
    name="set_theme",
    toolset="desktop_ui",
    schema=SET_THEME_SCHEMA,
    handler=lambda args, **kw: set_theme_tool(
        callback=kw.get("callback"), **{k: args.get(k) for k in ("accent", "mode", "layout", "picker", "settings", "inspect")}),
    emoji="🎨",
)
