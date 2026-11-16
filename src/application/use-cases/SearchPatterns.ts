import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import { withOwnerPatterns } from '../ownerPatterns.js';
import type { PatternCatalog, PatternSearchQuery, PatternSearchResult } from '../ports/PatternCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import { patternTexts } from '../catalogTexts.js';
import type { CatalogMeanings, CatalogText } from '../ports/CatalogMeanings.js';
import type { PatternEntry } from '../ports/PatternCatalog.js';

/** How many library entries the meaning ranks, the most a search returns */
const MEANING_LIMIT = 20;

/** The ranking, or the kind outside the allowed values with the kinds there are */
export type SearchPatternsResult =
    | { readonly kind: 'found'; readonly result: PatternSearchResult }
    | { readonly kind: 'invalid-argument'; readonly argument: InvalidSearchArgumentError['argument']; readonly allowed: readonly string[] };

/**
 * Screen patterns, the library's and the owner's, ranked for a need in plain words, each with its source;
 * never empty (a need with no match lists the patterns of the kind). With `meanings`, a weak keyword result is merged
 * with the library ranked by the need's meaning
 */
export class SearchPatterns {
    constructor(
        private readonly catalog: PatternCatalog,
        private readonly parts: Pick<UiPartRepository, 'list' | 'findByName'>,
        private readonly meanings?: CatalogMeanings
    ) {}

    private texts: CatalogText[] | undefined;

    async execute(query: PatternSearchQuery): Promise<SearchPatternsResult> {
        const catalog = await withOwnerPatterns(this.catalog, this.parts);
        try {
            const words = catalog.search(query);
            if (!words.weak || this.meanings === undefined) return { kind: 'found', result: words };
            this.texts ??= patternTexts(this.catalog.names().map((name) => this.catalog.get(name) as PatternEntry));
            const meaning = await this.meanings.rank('pattern', query.need, this.texts, MEANING_LIMIT).catch(() => undefined);
            return { kind: 'found', result: catalog.search(query, meaning) };
        } catch (error) {
            if (error instanceof InvalidSearchArgumentError) return { kind: 'invalid-argument', argument: error.argument, allowed: error.allowed };
            throw error;
        }
    }
}
