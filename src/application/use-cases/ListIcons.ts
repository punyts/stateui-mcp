import type { ComponentCatalog, IconMatch } from '../ports/ComponentCatalog.js';

export const DEFAULT_ICON_LIST_LIMIT = 30;
export const MAX_ICON_LIST_LIMIT = 100;

export interface ListIconsInput {
    readonly query?: string;
    readonly category?: string;
    readonly filled?: boolean;
    /** Defaults to 30; at most 100; at least 1 */
    readonly limit?: number;
}

export interface ListIconsResult {
    /** Best matches first: name, then alias, tag, category. No path data */
    readonly icons: readonly IconMatch[];
    /** All icons that matched */
    readonly total: number;
    /** How many matched beyond the ones returned */
    readonly more: number;
}

function clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ICON_LIST_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_ICON_LIST_LIMIT);
}

/** Searches the icon set. Aliases match as their target icon */
export class ListIcons {
    constructor(private readonly catalog: ComponentCatalog) {}

    execute(input: ListIconsInput = {}): ListIconsResult {
        const result = this.catalog.searchIcons({
            ...(input.query !== undefined && { query: input.query }),
            ...(input.category !== undefined && { category: input.category }),
            ...(input.filled !== undefined && { filled: input.filled }),
            limit: clampLimit(input.limit)
        });
        const icons = result.matches.map(({ name, category, tags, hasFilled }) => ({ name, category, tags, hasFilled }));
        return { icons, total: result.total, more: Math.max(result.total - icons.length, 0) };
    }
}
