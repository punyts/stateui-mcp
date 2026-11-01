import type { ComponentCatalog, ThemeOverlayEntry, ThemeToken } from '../ports/ComponentCatalog.js';

export interface ListTokensInput {
    /** A top-level token group such as `color` or `space`; case ignored */
    readonly group?: string;
    /** Words that must each appear in the token path or description, case ignored */
    readonly query?: string;
    /** True: the shipped overlays (kind, name and the groups the kind may touch) are returned too */
    readonly includeOverlays?: boolean;
}

export type ListTokensResult =
    /** The tokens that matched, in the order of the default tree, and the overlays when they were asked for */
    | { readonly kind: 'listed'; readonly tokens: readonly ThemeToken[]; readonly overlays?: readonly ThemeOverlayEntry[] }
    /** `group` is not a token group; `groups` lists the ones that exist */
    | { readonly kind: 'unknown-group'; readonly group: string; readonly groups: readonly string[] };

/**
 * The theme tokens a node's `theme` override may set, and the overlays a theme switch may name. Only the names and
 * defaults are listed; the values a minion writes are checked when the document is written
 */
export class ListTokens {
    constructor(private readonly catalog: ComponentCatalog) {}

    execute(input: ListTokensInput = {}): ListTokensResult {
        const all = this.catalog.listTokens();
        const group = (input.group ?? '').trim().toLowerCase();
        if (group !== '') {
            const groups = [...new Set(all.map((token) => token.group))];
            if (!groups.includes(group)) return { kind: 'unknown-group', group: (input.group ?? '').trim(), groups };
        }
        const words = (input.query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
        const tokens = all
            .filter((token) => group === '' || token.group === group)
            .filter((token) => {
                const text = `${token.path} ${token.description}`.toLowerCase();
                return words.every((word) => text.includes(word));
            });
        return input.includeOverlays === true
            ? { kind: 'listed', tokens, overlays: this.catalog.listOverlays() }
            : { kind: 'listed', tokens };
    }
}
