import { nearestNames } from '../../domain/nearestNames.js';
import { toComponentView } from '../componentView.js';
import type { ComponentView } from '../componentView.js';
import type { ComponentCatalog } from '../ports/ComponentCatalog.js';

export type GetComponentResult =
    | { readonly kind: 'found'; readonly component: ComponentView }
    /** `nearest` lists up to three known names close to the one asked for; it may be empty */
    | { readonly kind: 'not-found'; readonly name: string; readonly nearest: readonly string[] };

/** One component in the compact form an agent builds from (`toComponentView`) */
export class GetComponent {
    constructor(private readonly catalog: ComponentCatalog) {}

    execute(name: string): GetComponentResult {
        const entry = this.catalog.get(name);
        if (entry !== undefined) return { kind: 'found', component: toComponentView(entry) };
        return { kind: 'not-found', name, nearest: nearestNames(name, this.catalog.list().map((item) => item.name)) };
    }
}
