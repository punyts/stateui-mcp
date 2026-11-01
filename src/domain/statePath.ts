import { parseDocumentPath } from './DocumentPath.js';
import type { DocumentPath } from './DocumentPath.js';

/** Where a state path points: the data branch, the application tree, the runtime branch, or nowhere known */
export type StatePathTarget =
    | { readonly kind: 'data'; readonly path: DocumentPath }
    | { readonly kind: 'app'; readonly path: DocumentPath }
    | { readonly kind: 'runtime' }
    | { readonly kind: 'unknown' }
    | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Reads a state path such as `$.data.order.customer` or `$.app.children.name.value`. `path` holds the segments
 * below `data` or `app`. `$.runtime...` is its own kind because tools never write it; any other root key
 * (`$.theme`, `$.locale`) or `$` alone is `unknown`
 */
export function parseStatePath(text: string): StatePathTarget {
    if (text === '$') return { kind: 'unknown' };
    if (!text.startsWith('$.')) return { kind: 'invalid', reason: 'A state path starts with $' };
    const parsed = parseDocumentPath(text.slice(2));
    if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
    const [root, ...rest] = parsed.path as readonly string[];
    if (root === 'data') return { kind: 'data', path: rest };
    if (root === 'app') return { kind: 'app', path: rest };
    if (root === 'runtime') return { kind: 'runtime' };
    return { kind: 'unknown' };
}
