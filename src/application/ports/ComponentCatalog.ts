import type { JsonObject } from '../../domain/JsonValue.js';

export type ComponentTier = 'root' | 'composed';

/** One line of the component list */
export interface ComponentSummary {
    readonly name: string;
    readonly tier: ComponentTier;
    readonly size: string;
    readonly summary: string;
}

/** A token a component's CSS reads, which a node's `theme` may override for its subtree: `image.fill`, type `color`, default `{color.surface.sunken}` */
export interface ComponentToken {
    readonly path: string;
    readonly type: string;
    readonly default: string;
}

interface ComponentEntryBase extends ComponentSummary {
    readonly example: JsonObject;
    /** The component tokens, empty when the component declares none */
    readonly tokens: readonly ComponentToken[];
    /** The language codes the component ships translations for */
    readonly locales: readonly string[];
}

/** A root component: it draws itself and has a shape, slots, events and commands */
export interface RootComponentEntry extends ComponentEntryBase {
    readonly tier: 'root';
    readonly shape: JsonObject;
    readonly slots: readonly JsonObject[];
    readonly events: readonly string[];
    readonly commands: readonly string[];
}

/** A composed component: a default tree of other components, with the paths it exposes */
export interface ComposedComponentEntry extends ComponentEntryBase {
    readonly tier: 'composed';
    readonly tree: JsonObject;
    readonly exposes: readonly JsonObject[];
}

/** The full catalog entry of a component */
export type ComponentEntry = RootComponentEntry | ComposedComponentEntry;

export interface IconQuery {
    /** Words that must each appear in the icon name, one of its tags or an alias that names it */
    readonly query?: string;
    readonly category?: string;
    readonly filled?: boolean;
    readonly limit?: number;
}

export interface IconMatch {
    readonly name: string;
    readonly category: string;
    readonly tags: readonly string[];
    readonly hasFilled: boolean;
}

export interface IconSearchResult {
    readonly matches: readonly IconMatch[];
    /** How many icons matched in all, before `limit` */
    readonly total: number;
}

/** A semantic theme token: what a node's `theme` override may set */
export interface ThemeToken {
    /** Dotted path below `tokens`, such as `color.text.muted` */
    readonly path: string;
    readonly type: string;
    /** The value in the `light` mode and `default` brand; a reference stays as `{path}` */
    readonly default: string;
    /** The top-level group: the first segment of the path */
    readonly group: string;
    /** One line */
    readonly description: string;
}

/** A shipped theme overlay and the token groups its kind may touch */
export interface ThemeOverlayEntry {
    /** `mode`, `brand` or `motion` */
    readonly kind: string;
    readonly name: string;
    readonly groups: readonly string[];
}

/** What a person needs a component for, in plain words, with optional narrowing */
export interface ComponentSearchQuery {
    readonly need: string;
    /** Only components of this category; one of the categories the catalog uses */
    readonly category?: string;
    /** Only components of this tier; one of the tiers the catalog uses */
    readonly tier?: string;
    /** How many results; 5 by default, at most 20 */
    readonly limit?: number;
}

/** One component a search returned */
export interface ComponentSearchHit {
    readonly name: string;
    readonly category: string;
    readonly tier: string;
    readonly summary: string;
    /** The purpose phrases that hold a need word, then need words matched only elsewhere; empty for a fallback entry */
    readonly matched: readonly string[];
    readonly example: JsonObject;
}

/** One category that has members, with how many and three typical ones */
export interface CategoryIndexEntry {
    readonly category: string;
    readonly count: number;
    /** The three members with the most purposes, ties by name */
    readonly typical: readonly string[];
}

/** Never empty: a need with no match falls back to a category's entries */
export interface ComponentSearchResult {
    readonly results: readonly ComponentSearchHit[];
    /** True when the best match is below the weak floor, or nothing matched */
    readonly weak: boolean;
    /** The category index, given when nothing matched and no category was asked for */
    readonly categories?: readonly CategoryIndexEntry[];
}

/** A search argument outside the allowed values: an unknown `category` or `tier` */
export class InvalidSearchArgumentError extends Error {
    constructor(
        readonly argument: 'category' | 'tier',
        readonly allowed: readonly string[]
    ) {
        super(`Unknown ${argument}; use one of: ${allowed.join(', ')}`);
        this.name = 'InvalidSearchArgumentError';
    }
}

/** The component library, its theme tokens and the icon set, loaded once and read only */
export interface ComponentCatalog {
    list(): readonly ComponentSummary[];
    get(name: string): ComponentEntry | undefined;
    /** Components ranked for a need; throws `InvalidSearchArgumentError` for an unknown category or tier */
    search(query: ComponentSearchQuery): ComponentSearchResult;
    /** One entry per category that has members, in the order of `COMPONENT_CATEGORIES` */
    categoryIndex(): readonly CategoryIndexEntry[];
    searchIcons(query: IconQuery): IconSearchResult;
    /** The semantic tokens, in the order of the default token tree; primitive and component tokens are not here */
    listTokens(): readonly ThemeToken[];
    /** The shipped overlays, by kind (`mode`, `brand`, `motion`) and in the order the library ships them */
    listOverlays(): readonly ThemeOverlayEntry[];
    /** Path data by icon name; names that are not icons are left out */
    iconPaths(names: readonly string[]): Readonly<Record<string, string>>;
}
