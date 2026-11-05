import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import type { ComponentCatalog, ComponentSearchQuery, ComponentSearchResult } from '../ports/ComponentCatalog.js';

/** The ranking, or the argument outside the allowed values with the values it may take */
export type SearchComponentsResult =
    | { readonly kind: 'found'; readonly result: ComponentSearchResult }
    | { readonly kind: 'invalid-argument'; readonly argument: 'category' | 'tier'; readonly allowed: readonly string[] };

/** Components ranked for a need in plain words; never empty (a need with no match falls back to a category) */
export class SearchComponents {
    constructor(private readonly catalog: Pick<ComponentCatalog, 'search'>) {}

    execute(query: ComponentSearchQuery): SearchComponentsResult {
        try {
            return { kind: 'found', result: this.catalog.search(query) };
        } catch (error) {
            if (error instanceof InvalidSearchArgumentError) return { kind: 'invalid-argument', argument: error.argument, allowed: error.allowed };
            throw error;
        }
    }
}
