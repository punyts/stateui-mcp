import { createIconNames } from '@punyts/stateui-components';
import type { IconEntry, IconNames, IconPath, IconsFile } from '@punyts/stateui-components';
import type {
    ComponentCatalog,
    ComponentEntry,
    ComponentSummary,
    IconMatch,
    IconQuery,
    IconSearchResult,
    ThemeOverlayEntry,
    ThemeToken
} from '../application/ports/ComponentCatalog.js';
import type { CatalogFile, CatalogFileComponent } from './stateUiLibrary.js';

export const DEFAULT_ICON_LIMIT = 30;
export const MAX_ICON_LIMIT = 100;

function toSummary(component: CatalogFileComponent): ComponentSummary {
    return { name: component.name, tier: component.tier, size: component.size, summary: component.summary };
}

function toEntry(component: CatalogFileComponent): ComponentEntry {
    const tokens = (component.tokens ?? []).map((token) => ({ path: token.path, type: token.type, default: token.default }));
    const base = { ...toSummary(component), example: component.example, locales: component.locales, tokens };
    if (component.tier === 'composed') {
        return { ...base, tier: 'composed', tree: component.tree ?? {}, exposes: component.exposes ?? [] };
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

/** `ComponentCatalog` over `catalog.json` and `icons.json` of `@punyts/stateui-components`, both held in memory */
export class StateUiComponentCatalog implements ComponentCatalog {
    private readonly summaries: readonly ComponentSummary[];
    private readonly byName: ReadonlyMap<string, CatalogFileComponent>;
    private readonly iconNames: IconNames;
    private readonly aliasesByIcon: ReadonlyMap<string, readonly string[]>;
    private readonly tokens: readonly ThemeToken[];
    private readonly overlays: readonly ThemeOverlayEntry[];

    constructor(
        catalog: CatalogFile,
        private readonly icons: IconsFile
    ) {
        this.summaries = catalog.components.map(toSummary);
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
