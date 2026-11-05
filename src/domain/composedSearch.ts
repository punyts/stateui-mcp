import { COMPONENT_CATEGORIES, MAX_SUMMARY_LENGTH, checkPurposes, isComponentCategory } from '@punyts/stateui-app/core';
import type { ComponentCategory } from '@punyts/stateui-app/core';

/** The search fields an owner component may carry beside its tree */
export interface ComposedSearch {
    readonly summary?: string;
    readonly category?: ComponentCategory;
    readonly purposes?: readonly string[];
}

/** The search field a value breaks, with the reason, or `undefined` when all given fields are valid */
export interface SearchFieldProblem {
    readonly field: 'summary' | 'category' | 'purposes';
    readonly reason: string;
}

/**
 * Checks the search fields given to a write: `summary` one line of at most `MAX_SUMMARY_LENGTH` characters, `category`
 * one of the library's categories, `purposes` three to eight one-line phrases (`checkPurposes`). An empty `summary` or
 * `category` and an empty `purposes` list mean "remove" and pass. The library's repeated-phrase rule is for the library only
 */
export function searchFieldProblem(fields: { readonly summary?: unknown; readonly category?: unknown; readonly purposes?: unknown }): SearchFieldProblem | undefined {
    const { summary, category, purposes } = fields;
    if (summary !== undefined && summary !== '') {
        if (typeof summary !== 'string' || summary.trim() === '') return { field: 'summary', reason: 'must be a phrase' };
        if (/[\r\n]/.test(summary)) return { field: 'summary', reason: 'must be on one line' };
        if (summary.length > MAX_SUMMARY_LENGTH) return { field: 'summary', reason: `is longer than ${MAX_SUMMARY_LENGTH} characters` };
    }
    if (category !== undefined && category !== '' && !isComponentCategory(category)) {
        return { field: 'category', reason: `must be one of: ${COMPONENT_CATEGORIES.join(', ')}` };
    }
    if (purposes !== undefined && !(Array.isArray(purposes) && purposes.length === 0)) {
        const reason = checkPurposes(purposes);
        if (reason !== undefined) return { field: 'purposes', reason };
    }
    return undefined;
}

/**
 * The search fields after a write: a field the write leaves out keeps its stored value, an empty one is removed
 */
export function mergeSearch(stored: ComposedSearch, given: { readonly summary?: string; readonly category?: string; readonly purposes?: readonly string[] }): ComposedSearch {
    const summary = given.summary === undefined ? stored.summary : given.summary === '' ? undefined : given.summary;
    const category = given.category === undefined ? stored.category : given.category === '' ? undefined : (given.category as ComponentCategory);
    const purposes = given.purposes === undefined ? stored.purposes : given.purposes.length === 0 ? undefined : given.purposes;
    return { ...(summary !== undefined && { summary }), ...(category !== undefined && { category }), ...(purposes !== undefined && { purposes }) };
}

/** True when a component has all three search fields, so the component search can find it by need */
export function isSearchable(search: ComposedSearch): boolean {
    return search.summary !== undefined && search.category !== undefined && search.purposes !== undefined;
}
