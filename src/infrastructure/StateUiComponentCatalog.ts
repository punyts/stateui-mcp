import { COMPONENT_CATEGORIES, createSearchIndex } from '@punyts/stateui-app/core';
import type { SearchEntry, SearchIndex } from '@punyts/stateui-app/core';
import { createIconNames } from '@punyts/stateui-components';
import type { IconEntry, IconNames, IconPath, IconsFile } from '@punyts/stateui-components';
import { InvalidSearchArgumentError } from '../application/ports/ComponentCatalog.js';
import type {
    CategoryIndexEntry,
    ComponentCatalog,
    ComponentEntry,
    ComponentSearchHit,
    ComponentSearchQuery,
    ComponentSearchResult,
    ComponentSummary,
    IconMatch,
    IconQuery,
    IconSearchResult,
    OwnerComponent,
    ThemeOverlayEntry,
    ThemeToken
} from '../application/ports/ComponentCatalog.js';
import type { CatalogFile, CatalogFileComponent } from './stateUiLibrary.js';

export const DEFAULT_ICON_LIMIT = 30;
export const MAX_ICON_LIMIT = 100;

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

/**
 * Below this best score a search is weak. Set between the score of a need whose only match is one word of one
 * component's summary (weak) and one whose only match is one word of one purpose phrase (not weak); the catalog tests
 * pin both on the real catalog. One summary word scores above it: `delete`, in the short summary of `crudTable`
 */
export const WEAK_SCORE_FLOOR = 4.9;

/** The lowercased words of a camelCase name: `dateRangeField` is date, range, field */
function nameWords(name: string): string[] {
    return name.split(/(?=[A-Z])/).map((word) => word.toLowerCase());
}

/** A component the search ranks: a library entry or an owner component, with its search fields */
interface Candidate {
    readonly name: string;
    readonly category: string;
    readonly tier: string;
    readonly summary: string;
    readonly example: CatalogFileComponent['example'];
    readonly source: 'library' | 'owner';
    readonly entry: SearchEntry;
}

/** The four search fields of a catalog entry: purposes, name words, summary, and the property and event names of a root */
function libraryCandidate(component: CatalogFileComponent): Candidate {
    const properties = component.tier !== 'composed' ? [...Object.keys((component.shape?.['properties'] as object | undefined) ?? {}), ...(component.events ?? [])] : [];
    const { name, category, tier, summary, example } = component;
    const fields = { purposes: component.purposes, name: nameWords(name), summary: summary === '' ? [] : [summary], properties };
    return { name, category, tier, summary, example, source: 'library', entry: { id: name, fields } };
}

/** An owner component: searched by its purposes, name and summary when it has all three search fields, else by its name only */
function ownerCandidate(component: OwnerComponent): Candidate {
    const { name, summary = '', category = '', purposes = [] } = component;
    const searchable = summary !== '' && category !== '' && purposes.length > 0;
    const fields = searchable ? { purposes, name: nameWords(name), summary: [summary], properties: [] } : { purposes: [], name: nameWords(name), summary: [], properties: [] };
    return { name, category, tier: 'composed', summary, example: { component: name }, source: 'owner', entry: { id: name, fields } };
}

/** The letter trigrams of a text, with word edges, for the no-match fallback */
function trigrams(text: string): Set<string> {
    const grams = new Set<string>();
    for (const word of text.toLowerCase().split(/[^a-z]+/).filter((part) => part !== '')) {
        const padded = ` ${word} `;
        for (let index = 0; index + 3 <= padded.length; index++) grams.add(padded.slice(index, index + 3));
    }
    return grams;
}

function toSummary(component: CatalogFileComponent): ComponentSummary {
    return { name: component.name, tier: component.tier, size: component.size, summary: component.summary, category: component.category, purposes: component.purposes };
}

function toEntry(component: CatalogFileComponent): ComponentEntry {
    const tokens = (component.tokens ?? []).map((token) => ({ path: token.path, type: token.type, default: token.default }));
    const base = { ...toSummary(component), example: component.example, locales: component.locales, tokens };
    if (component.tier === 'composed') {
        return { ...base, tier: 'composed', tree: component.tree ?? {}, exposes: component.exposes ?? [] };
    }
    if (component.tier === 'shape') {
        return { ...base, tier: 'shape', shape: component.shape ?? {}, events: component.events ?? [] };
    }
    return {
        ...base,
        tier: 'root',
        shape: component.shape ?? {},
        slots: component.slots ?? [],
        events: component.events ?? [],
        commands: component.commands ?? []
    };
}

function pathData(path: IconPath): string {
    return typeof path === 'string' ? path : path.d;
}

/** How well an icon matches the words: lower is better. `undefined` when a word is in no name, alias or tag */
function rank(name: string, entry: IconEntry, aliases: readonly string[], words: readonly string[]): number | undefined {
    let worst = 0;
    for (const word of words) {
        let score: number | undefined;
        if (name === word) score = 0;
        else if (name.startsWith(word)) score = 1;
        else if (name.includes(word)) score = 2;
        else if (aliases.some((alias) => alias.includes(word))) score = 3;
        else if (entry.tags.some((tag) => String(tag).toLowerCase().includes(word))) score = 4;
        else if (entry.category.toLowerCase().includes(word)) score = 5;
        if (score === undefined) return undefined;
        worst = Math.max(worst, score);
    }
    return worst;
}

/** The candidates of a category and tier; either may be absent */
function candidatesOf(pool: readonly Candidate[], category: string | undefined, tier: string | undefined): readonly Candidate[] {
    return pool.filter((candidate) => (category === undefined || candidate.category === category) && (tier === undefined || candidate.tier === tier));
}

/** `ComponentCatalog` over `catalog.json` and `icons.json` of `@punyts/stateui-components`, both held in memory */
export class StateUiComponentCatalog implements ComponentCatalog {
    private readonly summaries: readonly ComponentSummary[];
    private readonly byName: ReadonlyMap<string, CatalogFileComponent>;
    private readonly iconNames: IconNames;
    private readonly aliasesByIcon: ReadonlyMap<string, readonly string[]>;
    private readonly tokens: readonly ThemeToken[];
    private readonly overlays: readonly ThemeOverlayEntry[];
    private readonly components: readonly CatalogFileComponent[];
    private readonly library: readonly Candidate[];
    private readonly categories: readonly CategoryIndexEntry[];
    private readonly tiers: readonly string[];
    /** One search index per narrowing (`category`/`tier`), built on first use */
    private readonly indexes = new Map<string, SearchIndex>();

    constructor(
        catalog: CatalogFile,
        private readonly icons: IconsFile
    ) {
        this.summaries = catalog.components.map(toSummary);
        this.components = catalog.components;
        this.library = catalog.components.map(libraryCandidate);
        this.tiers = [...new Set(catalog.components.map((component) => component.tier))].sort();
        this.categories = COMPONENT_CATEGORIES.flatMap((category) => {
            const members = catalog.components.filter((component) => component.category === category);
            if (members.length === 0) return [];
            const typical = [...members]
                .sort((a, b) => b.purposes.length - a.purposes.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                .slice(0, 3)
                .map((component) => component.name);
            return [{ category, count: members.length, typical }];
        });
        this.byName = new Map(catalog.components.map((component) => [component.name, component]));
        this.iconNames = createIconNames(icons);
        const aliases = new Map<string, string[]>();
        for (const [alias, target] of Object.entries(icons.aliases)) {
            aliases.set(target, [...(aliases.get(target) ?? []), alias]);
        }
        this.aliasesByIcon = aliases;
        this.tokens = catalog.theme.tokens.map(({ path, type, default: value, group, description }) => ({ path, type, default: value, group, description }));
        this.overlays = Object.entries(catalog.theme.overlays).flatMap(([kind, named]) =>
            named.map(({ name, groups }) => ({ kind, name, groups }))
        );
    }

    list(): readonly ComponentSummary[] {
        return this.summaries;
    }

    get(name: string): ComponentEntry | undefined {
        const component = this.byName.get(name);
        return component === undefined ? undefined : toEntry(component);
    }

    search(query: ComponentSearchQuery, owner: readonly OwnerComponent[] = []): ComponentSearchResult {
        const { category, tier } = query;
        if (category !== undefined && !(COMPONENT_CATEGORIES as readonly string[]).includes(category)) {
            throw new InvalidSearchArgumentError('category', COMPONENT_CATEGORIES);
        }
        if (tier !== undefined && !this.tiers.includes(tier)) throw new InvalidSearchArgumentError('tier', this.tiers);
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);

        const own = owner.filter((component) => !this.byName.has(component.name)).map(ownerCandidate);
        const pool = own.length === 0 ? this.library : [...this.library, ...own];
        const byName = new Map(pool.map((candidate) => [candidate.name, candidate]));
        const hit = (candidate: Candidate, matched: readonly string[]): ComponentSearchHit => {
            const { name, category: of, tier: at, summary, example, source } = candidate;
            return { name, category: of, tier: at, summary, matched, example, source };
        };

        const index = own.length === 0 ? this.indexFor(category, tier) : createSearchIndex(candidatesOf(pool, category, tier).map((candidate) => candidate.entry));
        const hits = index.search(query.need, limit);
        if (hits.length > 0) {
            return {
                results: hits.map((found) => hit(byName.get(found.id) as Candidate, found.matched)),
                weak: (hits[0]?.score ?? 0) < WEAK_SCORE_FLOOR
            };
        }
        if (category !== undefined) {
            return { results: candidatesOf(pool, category, tier).slice(0, limit).map((candidate) => hit(candidate, [])), weak: true };
        }
        const nearest = this.nearestCategory(query.need, tier);
        return {
            results: candidatesOf(pool, nearest, tier).slice(0, limit).map((candidate) => hit(candidate, [])),
            weak: true,
            categories: this.categories
        };
    }

    categoryIndex(): readonly CategoryIndexEntry[] {
        return this.categories;
    }

    private indexFor(category: string | undefined, tier: string | undefined): SearchIndex {
        const key = `${category ?? ''}/${tier ?? ''}`;
        let index = this.indexes.get(key);
        if (index === undefined) {
            index = createSearchIndex(candidatesOf(this.library, category, tier).map((candidate) => candidate.entry));
            this.indexes.set(key, index);
        }
        return index;
    }

    /** The category whose name and typical members share the most letter trigrams with the need; ties by the order of the list */
    private nearestCategory(need: string, tier: string | undefined): string {
        const wanted = trigrams(need);
        let best: { category: string; shared: number } | undefined;
        for (const entry of this.categories) {
            if (candidatesOf(this.library, entry.category, tier).length === 0) continue;
            const grams = trigrams([entry.category, ...entry.typical.flatMap(nameWords)].join(' '));
            const shared = [...wanted].filter((gram) => grams.has(gram)).length;
            if (best === undefined || shared > best.shared) best = { category: entry.category, shared };
        }
        return best?.category ?? this.categories[0]?.category ?? '';
    }

    searchIcons(query: IconQuery): IconSearchResult {
        const words = (query.query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
        const category = query.category?.toLowerCase();
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_ICON_LIMIT), 0), MAX_ICON_LIMIT);

        const ranked: { name: string; entry: IconEntry; score: number }[] = [];
        for (const [name, entry] of Object.entries(this.icons.icons)) {
            if (category !== undefined && entry.category.toLowerCase() !== category) continue;
            if (query.filled !== undefined && (entry.filled !== undefined) !== query.filled) continue;
            const score = rank(name, entry, this.aliasesByIcon.get(name) ?? [], words);
            if (score !== undefined) ranked.push({ name, entry, score });
        }
        ranked.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

        const matches: IconMatch[] = ranked.slice(0, limit).map(({ name, entry }) => ({
            name,
            category: entry.category,
            tags: entry.tags.map(String),
            hasFilled: entry.filled !== undefined
        }));
        return { matches, total: ranked.length };
    }

    listTokens(): readonly ThemeToken[] {
        return this.tokens;
    }

    listOverlays(): readonly ThemeOverlayEntry[] {
        return this.overlays;
    }

    iconPaths(names: readonly string[]): Readonly<Record<string, string>> {
        const paths: Record<string, string> = {};
        for (const name of names) {
            const target = this.iconNames.resolve(name);
            const entry = target === undefined ? undefined : this.icons.icons[target];
            if (entry !== undefined) paths[name] = entry.outline.map(pathData).join(' ');
        }
        return paths;
    }

    /** True for an icon name or an alias of one; the validator's `isIconName` */
    isIconName(name: string): boolean {
        return this.iconNames.isIconName(name);
    }
}
