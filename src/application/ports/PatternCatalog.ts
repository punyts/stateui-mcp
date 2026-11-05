import type { PatternPart, ThemePart } from '@punyts/stateui-app/core';

/** A library pattern by name: a shell or screen tree with its slots and params (the `*.pattern.json` format) */
export interface PatternEntry extends PatternPart {
    readonly name: string;
}

/** A library theme preset by name: base tokens and overlays, written as a theme part */
export interface ThemePresetEntry extends ThemePart {
    readonly name: string;
}

/**
 * The library's shell and screen patterns and theme presets, read only. Search epic 2 adds `search` and `presets`.
 * Until the built catalog has a `patterns` and a `themePresets` section, both lookups return `undefined`
 */
export interface PatternCatalog {
    get(name: string): PatternEntry | undefined;
    preset(name: string): ThemePresetEntry | undefined;
}
