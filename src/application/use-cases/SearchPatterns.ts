import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import type { PatternCatalog, PatternSearchQuery, PatternSearchResult } from '../ports/PatternCatalog.js';

/** The ranking, or the kind outside the allowed values with the kinds there are */
export type SearchPatternsResult =
    | { readonly kind: 'found'; readonly result: PatternSearchResult }
    | { readonly kind: 'invalid-argument'; readonly argument: InvalidSearchArgumentError['argument']; readonly allowed: readonly string[] };

/** Shell and screen patterns ranked for a need in plain words; never empty (a need with no match lists the patterns of the kind) */
export class SearchPatterns {
    constructor(private readonly catalog: Pick<PatternCatalog, 'search'>) {}

    execute(query: PatternSearchQuery): SearchPatternsResult {
        try {
            return { kind: 'found', result: this.catalog.search(query) };
        } catch (error) {
            if (error instanceof InvalidSearchArgumentError) return { kind: 'invalid-argument', argument: error.argument, allowed: error.allowed };
            throw error;
        }
    }
}
