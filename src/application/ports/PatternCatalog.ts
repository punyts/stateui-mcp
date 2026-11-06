import type { JsonValue, PatternKind, PatternPart, ThemePart } from '@punyts/stateui-app/core';

/** A library pattern by name: a shell or screen tree with its slots and params (the `*.pattern.json` format) */
export interface PatternEntry extends PatternPart {
    readonly name: string;
    /** The names of the components the tree uses, sorted; the build lists them */
    readonly components?: readonly string[];
}

/** A library theme preset by name: base tokens and overlays, written as a theme part */
export interface ThemePresetEntry extends ThemePart {
    readonly name: string;
}

/** What a person needs a shell or screen for, in plain words, with an optional kind */
export interface PatternSearchQuery {
    readonly need: string;
    /** Only patterns of this kind: `shell` or `screen` */
    readonly kind?: string;
    /** How many results; 5 by default, at most 20 */
    readonly limit?: number;
}

/** A param of a pattern as a search shows it: the value it takes, without the tree paths it is written to */
export interface PatternParamView {
    readonly type: string;
    readonly default?: JsonValue;
    readonly required?: boolean;
    readonly description: string;
}

/** One pattern a search returned */
export interface PatternSearchHit {
    readonly name: string;
    readonly kind: PatternKind;
    readonly summary: string;
    /** The purpose phrases that hold a need word, then need words matched only elsewhere; empty for a fallback entry */
    readonly matched: readonly string[];
    /** Slot name to what goes there */
    readonly slots: Readonly<Record<string, string>>;
    readonly params: Readonly<Record<string, PatternParamView>>;
    readonly components: readonly string[];
    /** Where the pattern comes from: `library` (the owner's own patterns arrive with search epic 2 S2.8) */
    readonly source: 'library';
}

/**
 * Never empty: a need with no match falls back to the patterns of the kind, or of both kinds when no kind is given or
 * the kind has no patterns
 */
export interface PatternSearchResult {
    readonly results: readonly PatternSearchHit[];
    /** True when nothing matched, or the best match matched no purpose phrase */
    readonly weak: boolean;
}

/**
 * The library's shell and screen patterns and theme presets, read only. `search` ranks patterns for a need and
 * throws `InvalidSearchArgumentError` for an unknown kind. Until the built catalog has a `themePresets` section,
 * `preset` returns `undefined`
 */
export interface PatternCatalog {
    get(name: string): PatternEntry | undefined;
    search(query: PatternSearchQuery): PatternSearchResult;
    preset(name: string): ThemePresetEntry | undefined;
}
