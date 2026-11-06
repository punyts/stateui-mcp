import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import type { ComponentCatalog, ComponentSearchQuery, ComponentSearchResult, OwnerComponent } from '../ports/ComponentCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';

/** The ranking, or the argument outside the allowed values with the values it may take */
export type SearchComponentsResult =
    | { readonly kind: 'found'; readonly result: ComponentSearchResult }
    | { readonly kind: 'invalid-argument'; readonly argument: InvalidSearchArgumentError['argument']; readonly allowed: readonly string[] };

/**
 * Components, the library's and the owner's (`ui_composed_write`, read at each call), ranked for a need in plain words,
 * each with its source; never empty (a need with no match falls back to a category)
 */
export class SearchComponents {
    constructor(
        private readonly catalog: Pick<ComponentCatalog, 'search'>,
        private readonly parts?: Pick<UiPartRepository, 'list' | 'findByName'>
    ) {}

    async execute(query: ComponentSearchQuery): Promise<SearchComponentsResult> {
        const owner = await this.ownerComponents();
        try {
            return { kind: 'found', result: this.catalog.search(query, owner) };
        } catch (error) {
            if (error instanceof InvalidSearchArgumentError) return { kind: 'invalid-argument', argument: error.argument, allowed: error.allowed };
            throw error;
        }
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
