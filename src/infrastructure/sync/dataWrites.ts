import type { JsonValue as SyncValue } from '@punyts/state-sync';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonValue } from '../../domain/JsonValue.js';

/** A server write that sets or deletes one path */
export type DataWrite = { path: string; op: 'set'; value: SyncValue } | { path: string; op: 'delete' };

export function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** The writes that turn `previous` into `next` at `path`: into objects key by key, anything else whole */
export function dataWrites(path: string, previous: JsonValue | undefined, next: JsonValue | undefined, writes: DataWrite[]): void {
    if (sameJson(previous, next)) return;
    if (next === undefined) {
        writes.push({ path, op: 'delete' });
        return;
    }
    if (!isJsonObject(previous) || !isJsonObject(next)) {
        writes.push({ path, op: 'set', value: next as SyncValue });
        return;
    }
    for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) writes.push({ path: `${path}.${key}`, op: 'delete' });
    for (const [key, value] of Object.entries(next)) dataWrites(`${path}.${key}`, previous[key], value, writes);
}

/** True when `path` is `base` or below it */
export function isAtOrBelow(path: string, base: string): boolean {
    return path === base || path.startsWith(`${base}.`);
}
