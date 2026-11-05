import { createRequire } from 'node:module';
import type { IconsFile } from '@punyts/stateui-components';
import type { PatternEntry, ThemePresetEntry } from '../application/ports/PatternCatalog.js';
import type { JsonObject } from '../domain/JsonValue.js';

/** A catalog entry as `catalog.json` holds it. A root entry has `shape`, a composed one has `tree` and `exposes` */
export interface CatalogFileComponent {
    readonly name: string;
    readonly tier: 'root' | 'composed';
    readonly tag: string;
    readonly size: string;
    /** One line; a composed entry has it since `@punyts/stateui-components` keys its composed files */
    readonly summary: string;
    /** One of `COMPONENT_CATEGORIES` */
    readonly category: string;
    /** Three to eight phrases of what the component is for */
    readonly purposes: readonly string[];
    readonly example: JsonObject;
    readonly locales: readonly string[];
    readonly shape?: JsonObject;
    readonly placement?: JsonObject;
    readonly slots?: readonly JsonObject[];
    readonly events?: readonly string[];
    readonly commands?: readonly string[];
    readonly tree?: JsonObject;
    readonly exposes?: readonly JsonObject[];
    /** The component tokens the shape declares, such as `image.fill` */
    readonly tokens?: readonly { readonly path: string; readonly group: string; readonly type: string; readonly default: string }[];
}

/** The `theme` section of `catalog.json`: the semantic tokens and the shipped overlays by kind */
export interface CatalogFileTheme {
    readonly tokens: readonly {
        readonly path: string;
        readonly type: string;
        readonly default: string;
        readonly group: string;
        readonly description: string;
    }[];
    readonly overlays: Readonly<Record<string, readonly { readonly name: string; readonly groups: readonly string[] }[]>>;
}

/** The part of `catalog.json` the adapters read */
export interface CatalogFile {
    readonly components: readonly CatalogFileComponent[];
    readonly theme: CatalogFileTheme;
    /** The library's shell and screen patterns, by name; absent until search epic 2 S2.1b builds them (S2.5 makes it required) */
    readonly patterns?: readonly PatternEntry[];
    /** The library's theme presets, by name; absent until search epic 2 S2.7 */
    readonly themePresets?: readonly ThemePresetEntry[];
}

/**
 * The files are read through `createRequire`, so Node resolves the package exports
 * `@punyts/stateui-components/catalog.json` and `/icons.json` itself, with or without a bundler alias
 */
const requireJson = createRequire(import.meta.url);

let catalogFile: CatalogFile | undefined;
let iconsFile: IconsFile | undefined;

/** True when every component carries the search keys `category` and `purposes` */
export function hasSearchKeys(components: readonly unknown[]): boolean {
    return components.every((component) => {
        const entry = component as { category?: unknown; purposes?: unknown } | null;
        return typeof entry?.category === 'string' && Array.isArray(entry.purposes) && entry.purposes.every((phrase) => typeof phrase === 'string');
    });
}

export function isCatalogFile(value: unknown): value is CatalogFile {
    if (typeof value !== 'object' || value === null) return false;
    const file = value as { components?: unknown; theme?: unknown };
    if (!Array.isArray(file.components)) return false;
    const theme = file.theme as { tokens?: unknown; overlays?: unknown } | null | undefined;
    return typeof theme === 'object' && theme !== null && Array.isArray(theme.tokens) && typeof theme.overlays === 'object' && theme.overlays !== null;
}

function isIconsFile(value: unknown): value is IconsFile {
    if (typeof value !== 'object' || value === null) return false;
    const file = value as { icons?: unknown; aliases?: unknown };
    return typeof file.icons === 'object' && file.icons !== null && typeof file.aliases === 'object' && file.aliases !== null;
}

/** `catalog.json` of the component library, read once per process */
export function loadCatalogFile(): CatalogFile {
    if (catalogFile === undefined) {
        const parsed: unknown = requireJson('@punyts/stateui-components/catalog.json');
        if (!isCatalogFile(parsed)) throw new Error('@punyts/stateui-components/catalog.json has no components list and theme section; rebuild @punyts/stateui-components');
        if (!hasSearchKeys(parsed.components)) {
            throw new Error('@punyts/stateui-components/catalog.json has components without "category" or "purposes"; rebuild @punyts/stateui-components');
        }
        catalogFile = parsed;
    }
    return catalogFile;
}

/**
 * The shipped overlay of one component for one language (`<name>.locale.<code>.json`), or `undefined` when the
 * component has none. Callers pass only names and codes the catalog lists, never document input
 */
export function loadComponentOverlay(name: string, code: string): JsonObject | undefined {
    try {
        const parsed: unknown = requireJson(`@punyts/stateui-components/components/${name}.locale.${code}.json`);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
    } catch {
        return undefined;
    }
}

/** `icons.json` of the component library, read once per process */
export function loadIconsFile(): IconsFile {
    if (iconsFile === undefined) {
        const parsed: unknown = requireJson('@punyts/stateui-components/icons.json');
        if (!isIconsFile(parsed)) throw new Error('@punyts/stateui-components/icons.json has no icons list');
        iconsFile = parsed;
    }
    return iconsFile;
}
