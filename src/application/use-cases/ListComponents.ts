import type { ComponentCatalog, ComponentSummary, ComponentTier } from '../ports/ComponentCatalog.js';

export interface ListComponentsInput {
    /** Words that must each appear in the name or the summary, case ignored */
    readonly query?: string;
    readonly tier?: ComponentTier;
}

/** The compact component list: one `{ name, tier, size, summary }` per component, no shapes */
export class ListComponents {
    constructor(private readonly catalog: ComponentCatalog) {}

    execute(input: ListComponentsInput = {}): readonly ComponentSummary[] {
        const words = (input.query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
        return this.catalog
            .list()
            .filter((component) => input.tier === undefined || component.tier === input.tier)
            .filter((component) => {
                const text = `${component.name} ${component.summary}`.toLowerCase();
                return words.every((word) => text.includes(word));
            })
            .map(({ name, tier, size, summary }) => ({ name, tier, size, summary }));
    }
}
