import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import type { ComponentCatalog, ComponentSearchQuery, ComponentSearchResult, OwnerComponent } from '../ports/ComponentCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import { componentTexts } from '../catalogTexts.js';
import type { CatalogMeaning, CatalogMeanings, CatalogText } from '../ports/CatalogMeanings.js';

/** How many library entries the meaning ranks, the most a search returns */
const MEANING_LIMIT = 20;

/** The ranking, or the argument outside the allowed values with the values it may take */
export type SearchComponentsResult =
    | { readonly kind: 'found'; readonly result: ComponentSearchResult }
    | { readonly kind: 'invalid-argument'; readonly argument: InvalidSearchArgumentError['argument']; readonly allowed: readonly string[] };

/**
 * Components, the library's and the owner's (`ui_composed_write`, read at each call), ranked for a need in plain words,
 * each with its source; never empty (a need with no match falls back to a category). With `meanings`, a weak keyword
 * result is merged with the library ranked by the need's meaning
 */
export class SearchComponents {
    constructor(
        private readonly catalog: Pick<ComponentCatalog, 'search' | 'list'>,
        private readonly parts?: Pick<UiPartRepository, 'list' | 'findByName'>,
        private readonly meanings?: CatalogMeanings
    ) {}

    private texts: CatalogText[] | undefined;

    async execute(query: ComponentSearchQuery): Promise<SearchComponentsResult> {
        const owner = await this.ownerComponents();
        try {
            const words = this.catalog.search(query, owner);
            if (!words.weak || this.meanings === undefined || query.need.trim() === '') return { kind: 'found', result: words };
            return { kind: 'found', result: this.catalog.search(query, owner, await this.meaningOf(query.need)) };
        } catch (error) {
            if (error instanceof InvalidSearchArgumentError) return { kind: 'invalid-argument', argument: error.argument, allowed: error.allowed };
            throw error;
        }
    }

    /** The library ranked by the need's meaning; none when the ranker fails, so a search never fails for it */
    private async meaningOf(need: string): Promise<CatalogMeaning | undefined> {
        this.texts ??= componentTexts(this.catalog.list());
        return (this.meanings as CatalogMeanings).rank('component', need, this.texts, MEANING_LIMIT).catch(() => undefined);
    }

    private async ownerComponents(): Promise<OwnerComponent[]> {
        if (this.parts === undefined) return [];
        const owner: OwnerComponent[] = [];
        for (const summary of await this.parts.list('components')) {
            const part = await this.parts.findByName('components', summary.name);
            if (part === undefined) continue;
            const { summary: line, category, purposes } = part.body as { summary?: string; category?: string; purposes?: readonly string[] };
            owner.push({ name: part.name, ...(line !== undefined && { summary: line }), ...(category !== undefined && { category }), ...(purposes !== undefined && { purposes }) });
        }
        return owner;
    }
}
