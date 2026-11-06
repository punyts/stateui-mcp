import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import { withOwnerPatterns } from '../ownerPatterns.js';
import type { PatternCatalog, PatternSearchQuery, PatternSearchResult } from '../ports/PatternCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';

/** The ranking, or the kind outside the allowed values with the kinds there are */
export type SearchPatternsResult =
    | { readonly kind: 'found'; readonly result: PatternSearchResult }
    | { readonly kind: 'invalid-argument'; readonly argument: InvalidSearchArgumentError['argument']; readonly allowed: readonly string[] };

/**
 * Shell and screen patterns, the library's and the owner's, ranked for a need in plain words, each with its source;
 * never empty (a need with no match lists the patterns of the kind)
 */
export class SearchPatterns {
    constructor(
        private readonly catalog: PatternCatalog,
        private readonly parts: Pick<UiPartRepository, 'list' | 'findByName'>
    ) {}

    async execute(query: PatternSearchQuery): Promise<SearchPatternsResult> {
        const catalog = await withOwnerPatterns(this.catalog, this.parts);
        try {
            return { kind: 'found', result: catalog.search(query) };
        } catch (error) {
            if (error instanceof InvalidSearchArgumentError) return { kind: 'invalid-argument', argument: error.argument, allowed: error.allowed };
            throw error;
        }
    }
}
