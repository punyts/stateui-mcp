import { forgetNamespace } from '@punyts/state-sync';
import type { LocalStore } from '@punyts/state-sync';

/**
 * Deletes what the browser keeps of each namespace a page lists in `data-forget` (space separated): an instance the
 * person no longer has, such as their own after a move from `use` to `view`. The namespace the page opens is never
 * one of them
 */
export function forgetListed(store: LocalStore, listed: string | undefined, opened: string): void {
    for (const namespace of (listed ?? '').split(' ')) if (namespace !== '' && namespace !== opened) forgetNamespace(store, namespace);
}
