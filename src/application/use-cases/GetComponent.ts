import { nearestNames } from '../../domain/nearestNames.js';
import type { ComponentCatalog, ComponentEntry } from '../ports/ComponentCatalog.js';

export type GetComponentResult =
    | { readonly kind: 'found'; readonly component: ComponentEntry }
    /** `nearest` lists up to three known names close to the one asked for; it may be empty */
    | { readonly kind: 'not-found'; readonly name: string; readonly nearest: readonly string[] };

/** The full catalog entry of one component */
export class GetComponent {
    constructor(private readonly catalog: ComponentCatalog) {}

    execute(name: string): GetComponentResult {
        const component = this.catalog.get(name);
        if (component !== undefined) return { kind: 'found', component };
        return { kind: 'not-found', name, nearest: nearestNames(name, this.catalog.list().map((entry) => entry.name)) };
    }
}
