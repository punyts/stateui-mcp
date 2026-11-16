import { isJsonObject } from '../../domain/JsonValue.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { ComponentCatalog, IconMatch } from '../ports/ComponentCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';

export const DEFAULT_ICON_LIST_LIMIT = 30;
export const MAX_ICON_LIST_LIMIT = 100;

/** The category an app's own icon is listed under */
export const APP_ICON_CATEGORY = 'app';

export interface ListIconsInput {
    readonly query?: string;
    readonly category?: string;
    readonly filled?: boolean;
    /** Defaults to 30; at most 100; at least 1 */
    readonly limit?: number;
    /** An app part name: its own icons are listed first, before the icon set's */
    readonly app?: string;
}

/** An icon of the list: from the icon set (`set`) or one of the app's own (`app`) */
export interface ListedIcon extends IconMatch {
    readonly source: 'set' | 'app';
}

export interface ListIconsResult {
    /** Best matches first, the app's own icons before the icon set's: name, then alias, tag, category. No path data */
    readonly icons: readonly ListedIcon[];
    /** All icons that matched */
    readonly total: number;
    /** How many matched beyond the ones returned */
    readonly more: number;
}

export type ListIconsOutcome = { readonly kind: 'listed'; readonly result: ListIconsResult } | { readonly kind: 'app-not-found'; readonly nearest: readonly string[] };

function clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ICON_LIST_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_ICON_LIST_LIMIT);
}

/** True when every word of `query` is in the name (an app icon has no tags) */
function matchesWords(name: string, query: string | undefined): boolean {
    const words = (query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
    return words.every((word) => name.includes(word));
}

/**
 * Searches the icon set, aliases matching as their target icon. Given an app, its own icons that match come first
 * (category `app`), and an icon of the set with the name of one of them is left out, since the app's wins
 */
export class ListIcons {
    constructor(
        private readonly catalog: ComponentCatalog,
        private readonly parts?: Pick<UiPartRepository, 'findByName' | 'list'>
    ) {}

    async execute(input: ListIconsInput = {}): Promise<ListIconsOutcome> {
        const limit = clampLimit(input.limit);
        let own: ListedIcon[] = [];
        if (input.app !== undefined) {
            const app = this.parts === undefined ? undefined : await this.parts.findByName('apps', input.app);
            if (app === undefined) {
                const names = this.parts === undefined ? [] : (await this.parts.list('apps')).map((summary) => summary.name);
                return { kind: 'app-not-found', nearest: nearestNames(input.app, names) };
            }
            const icons = (app.body as unknown as Record<string, unknown>)['icons'];
            const entries = isJsonObject(icons) ? Object.entries(icons) : [];
            own = entries
                .filter(([name]) => matchesWords(name, input.query))
                .filter(() => input.category === undefined || input.category === APP_ICON_CATEGORY)
                .map(([name, icon]) => ({ name, category: APP_ICON_CATEGORY, tags: [], hasFilled: isJsonObject(icon) && Array.isArray(icon['filled']), source: 'app' as const }))
                .filter((icon) => input.filled !== true || icon.hasFilled);
        }
        const ownNames = new Set(own.map((icon) => icon.name));
        const result =
            input.category === APP_ICON_CATEGORY
                ? { matches: [], total: 0 }
                : this.catalog.searchIcons({
                      ...(input.query !== undefined && { query: input.query }),
                      ...(input.category !== undefined && { category: input.category }),
                      ...(input.filled !== undefined && { filled: input.filled }),
                      limit: limit + ownNames.size
                  });
        const set = result.matches
            .filter((match) => !ownNames.has(match.name))
            .map(({ name, category, tags, hasFilled }) => ({ name, category, tags, hasFilled, source: 'set' as const }));
        const shadowed = result.matches.length - set.length;
        const icons = [...own, ...set].slice(0, limit);
        const total = own.length + result.total - shadowed;
        return { kind: 'listed', result: { icons, total, more: Math.max(total - icons.length, 0) } };
    }
}
