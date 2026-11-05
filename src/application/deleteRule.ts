import type { PartRef } from '@punyts/stateui-app/core';
import type { PartKind } from '../domain/partName.js';
import { PART_KIND_WORDS } from '../domain/partReferences.js';
import type { UsageIndex } from './UsageIndex.js';

/** What `ui_delete` deletes: a part, or a screen of an app */
export type DeleteTarget =
    | { readonly kind: PartKind; readonly name: string }
    | { readonly kind: 'screens'; readonly app: string; readonly name: string };

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
 * Whether a part or a screen may be deleted: a part while nothing uses it, a screen while it is not its app's `start`.
 * A refusal names every user, so the caller can change them first
 */
export function deleteRule(index: UsageIndex, target: DeleteTarget): DeleteRuling {
    if (target.kind === 'screens') {
        const users = index.usedBy('screens', target.name, target.app);
        if (users.length === 0) return { kind: 'ok' };
        return { kind: 'refused', reason: `The screen "${target.name}" is the start screen of the app "${target.app}": make another screen the start first`, users };
    }
    const users = index.usedBy(target.kind, target.name);
    if (users.length === 0) return { kind: 'ok' };
    return { kind: 'refused', reason: `The ${PART_KIND_WORDS[target.kind]} "${target.name}" is used by ${listed(users)}: change or delete them first`, users };
}
