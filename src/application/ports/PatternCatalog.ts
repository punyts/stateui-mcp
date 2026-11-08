import type { JsonValue, PatternKind, PatternPart, ThemePart } from '@punyts/stateui-app/core';

/** Where a pattern comes from: the component library, or the owner's `patterns` parts */
export type PatternSource = 'library' | 'owner';

/** A pattern by name: a screen tree with its slots and params (the `*.pattern.json` format) */
export interface PatternEntry extends PatternPart {
    readonly name: string;
    /** The names of the components the tree uses, sorted; the build lists them */
    readonly components?: readonly string[];
    /** Absent: `library` */
    readonly source?: PatternSource;
}

/** An owner's pattern part: its name and stored body */
export interface OwnerPattern {
    readonly name: string;
    readonly body: PatternPart;
}

/** A library theme preset by name: base tokens and overlays, written as a theme part, with a one-line summary */
export interface ThemePresetEntry extends ThemePart {
    readonly name: string;
    /** What the preset looks like, for the tool text; not copied into the theme */
    readonly summary?: string;
}

/** A theme preset as the tool text names it */
export interface ThemePresetSummary {
    readonly name: string;
    readonly summary: string;
}

/** What a person needs a screen for, in plain words, with an optional kind */
export interface PatternSearchQuery {
    readonly need: string;
    /** Only patterns of this kind: `screen`, the one kind */
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
    /** Where the pattern comes from: the library, or the owner (`ui_pattern_write`) */
    readonly source: PatternSource;
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
 * The screen patterns and theme presets of the library, and with `withOwner` of the owner too, read only. `search` ranks patterns for a need and
 * throws `InvalidSearchArgumentError` for an unknown kind. Until the built catalog has a `themePresets` section,
 * `preset` returns `undefined` and `presets` is empty
 */
export interface PatternCatalog {
    get(name: string): PatternEntry | undefined;
    /** Every pattern name, of both kinds, in catalog order */
    names(): readonly string[];
    search(query: PatternSearchQuery): PatternSearchResult;
    preset(name: string): ThemePresetEntry | undefined;
    /** Every theme preset name, in catalog order; empty while the catalog has none */
    presets(): readonly string[];
    /**
     * The library's patterns and these owner patterns together, ranked as one, each hit with its `source`. An owner
     * pattern whose name a library pattern has is left out (`ui_pattern_write` refuses such a name), so `get` never
     * meets two patterns of one name. Owner patterns may repeat a library pattern's purposes; both rank
     */
    withOwner(owner: readonly OwnerPattern[]): PatternCatalog;
}
