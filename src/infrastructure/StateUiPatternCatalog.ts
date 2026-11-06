import { PATTERN_KINDS, createSearchIndex, patternComponents } from '@punyts/stateui-app/core';
import type { ComponentLibrary, SearchEntry, SearchIndex } from '@punyts/stateui-app/core';
import { InvalidSearchArgumentError } from '../application/ports/ComponentCatalog.js';
import type {
    OwnerPattern,
    PatternCatalog,
    PatternEntry,
    PatternParamView,
    PatternSearchHit,
    PatternSearchQuery,
    PatternSearchResult,
    ThemePresetEntry
} from '../application/ports/PatternCatalog.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './StateUiComponentCatalog.js';
import type { CatalogFile } from './stateUiLibrary.js';

/**
 * The four search fields of a pattern, for the engine of `ui_components_search`: purposes (weight 3), the words of
 * its hyphenated name (2), summary (1), and the names of its slots and params (0.5)
 */
function searchEntry(pattern: PatternEntry): SearchEntry {
    return {
        id: pattern.name,
        fields: {
            purposes: pattern.purposes,
            name: pattern.name.split('-'),
            summary: pattern.summary === '' ? [] : [pattern.summary],
            properties: [...Object.keys(pattern.slots), ...Object.keys(pattern.params)]
        }
    };
}

function paramView(param: PatternEntry['params'][string]): PatternParamView {
    return {
        type: param.type,
        ...(param.default === undefined ? {} : { default: param.default }),
        ...(param.required === true ? { required: true } : {}),
        description: param.description
    };
}

function toHit(pattern: PatternEntry, matched: readonly string[]): PatternSearchHit {
    return {
        name: pattern.name,
        kind: pattern.kind,
        summary: pattern.summary,
        matched,
        slots: Object.fromEntries(Object.entries(pattern.slots).map(([name, slot]) => [name, slot.description])),
        params: Object.fromEntries(Object.entries(pattern.params).map(([name, param]) => [name, paramView(param)])),
        components: [...(pattern.components ?? [])],
        source: pattern.source ?? 'library'
    };
}

/**
 * `PatternCatalog` over the `patterns` and optional `themePresets` sections of `catalog.json`. Search uses the
 * engine of the component search. A pattern catalog is small, so the component catalog's score floor does not carry
 * over: a result is weak when nothing matched or when the best match holds none of its purpose phrases. `withOwner`
 * adds the owner's patterns, their components listed through the library (an owner component counts as its own name)
 */
export class StateUiPatternCatalog implements PatternCatalog {
    private readonly catalog: Pick<CatalogFile, 'patterns'> & Partial<Pick<CatalogFile, 'themePresets'>>;
    private readonly library: ComponentLibrary;
    private readonly patterns: ReadonlyMap<string, PatternEntry>;
    private readonly presetsByName: ReadonlyMap<string, ThemePresetEntry>;
    /** One search index per kind (`''` for both), built on first use */
    private readonly indexes = new Map<string, SearchIndex>();

    constructor(
        catalog: Pick<CatalogFile, 'patterns'> & Partial<Pick<CatalogFile, 'themePresets'>>,
        library: ComponentLibrary = {},
        owner: readonly OwnerPattern[] = []
    ) {
        this.catalog = catalog;
        this.library = library;
        const entries: [string, PatternEntry][] = catalog.patterns.map((pattern) => [pattern.name, pattern]);
        const libraryNames = new Set(catalog.patterns.map((pattern) => pattern.name));
        for (const { name, body } of owner) {
            if (libraryNames.has(name)) continue;
            entries.push([name, { ...body, name, source: 'owner', components: patternComponents(body, library) }]);
        }
        this.patterns = new Map(entries);
        this.presetsByName = new Map((catalog.themePresets ?? []).map((preset) => [preset.name, preset]));
    }

    get(name: string): PatternEntry | undefined {
        return this.patterns.get(name);
    }

    names(): readonly string[] {
        return [...this.patterns.keys()];
    }

    search(query: PatternSearchQuery): PatternSearchResult {
        const { kind } = query;
        if (kind !== undefined && !(PATTERN_KINDS as readonly string[]).includes(kind)) throw new InvalidSearchArgumentError('kind', PATTERN_KINDS);
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);

        const hits = this.indexFor(kind).search(query.need, limit);
        if (hits.length === 0) {
            // Never empty: a kind with no patterns at all falls back to the patterns of both kinds
            const ofKind = this.candidates(kind);
            const fallback = ofKind.length > 0 ? ofKind : this.candidates(undefined);
            return { results: fallback.slice(0, limit).map((pattern) => toHit(pattern, [])), weak: true };
        }
        const results = hits.map((hit) => toHit(this.patterns.get(hit.id) as PatternEntry, hit.matched));
        const best = results[0] as PatternSearchHit;
        const purposes = (this.patterns.get(best.name) as PatternEntry).purposes;
        return { results, weak: !best.matched.some((phrase) => purposes.includes(phrase)) };
    }

    preset(name: string): ThemePresetEntry | undefined {
        return this.presetsByName.get(name);
    }

    presets(): readonly string[] {
        return [...this.presetsByName.keys()];
    }

    withOwner(owner: readonly OwnerPattern[]): PatternCatalog {
        return owner.length === 0 ? this : new StateUiPatternCatalog(this.catalog, this.library, owner);
    }

    /** The patterns of a kind, or of both kinds, in catalog order (kind, then name) */
    private candidates(kind: string | undefined): readonly PatternEntry[] {
        return [...this.patterns.values()].filter((pattern) => kind === undefined || pattern.kind === kind);
    }

    private indexFor(kind: string | undefined): SearchIndex {
        const key = kind ?? '';
        let index = this.indexes.get(key);
        if (index === undefined) {
            index = createSearchIndex(this.candidates(kind).map(searchEntry));
            this.indexes.set(key, index);
        }
        return index;
    }
}
