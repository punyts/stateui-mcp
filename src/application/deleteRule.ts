import type { PartRef } from '@punyts/stateui-app/core';
import type { PartKind } from '../domain/partName.js';
import { PART_KIND_WORDS } from '../domain/partReferences.js';
import type { UsageIndex } from './UsageIndex.js';

/** A part `ui_delete` would delete */
export interface DeleteTarget {
    readonly kind: PartKind;
    readonly name: string;
}

export type DeleteRuling =
    | { readonly kind: 'ok' }
    | { readonly kind: 'refused'; readonly reason: string; readonly users: readonly PartRef[] };

function named(ref: PartRef): string {
    return `the ${PART_KIND_WORDS[ref.kind]} "${ref.name}"`;
}

function listed(refs: readonly PartRef[]): string {
    const words = refs.map(named);
    return words.length === 1 ? (words[0] as string) : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Whether a part may be deleted: while nothing uses it. A refusal names every user, so the caller can change them first.
 * A screen may always be deleted (`appWithoutScreen` moves the app's `start`)
 */
export function deleteRule(index: UsageIndex, target: DeleteTarget): DeleteRuling {
    const users = index.usedBy(target.kind, target.name);
    if (users.length === 0) return { kind: 'ok' };
    return { kind: 'refused', reason: `The ${PART_KIND_WORDS[target.kind]} "${target.name}" is used by ${listed(users)}: change or delete them first`, users };
}
