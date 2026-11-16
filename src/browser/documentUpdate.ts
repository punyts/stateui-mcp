/**
 * The document side of the live view host: a new document as the writes that bring the runtime from the document it
 * shows to the new one, or a full load when writes cannot carry the change. Pure, so it is tested without a page.
 */

import type { JsonValue } from '@punyts/state-sync';

export type Json = JsonValue;
export type JsonRecord = { [key: string]: Json };

export const MAX_WRITES = 500;
export const SEGMENT = /^[^.\s]+$/;

/** The paths a write never replaces whole: the data, the app node and the root of each screen */
const TREE_ROOT = /^\$\.(?:data|app|screens\.[^.\s]+)$/;

export interface PathWrite {
    path: string;
    value?: Json;
    remove?: true;
}

export function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJson(value: unknown): value is Json {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJson);
    if (isRecord(value)) return Object.values(value).every(isJson);
    return false;
}

export function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
    if (isRecord(a) && isRecord(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
    }
    return false;
}

/**
 * True when every record in `a` that is not a node has its keys in the same order as the record at the same place in
 * `b`. The order of a node's own properties means nothing, but the order of its `children` (a record keyed by child
 * id) is the order they render in
 */
function sameKeyOrder(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) return a.every((item, index) => sameKeyOrder(item, b[index]));
    if (!isRecord(a) || !isRecord(b)) return true;
    const keys = Object.keys(a);
    if (!isNode(a) && !isNode(b) && keys.some((key, index) => Object.keys(b)[index] !== key)) return false;
    return keys.every((key) => sameKeyOrder(a[key], b[key]));
}

/**
 * The keys of `b` that writes must remove and put back so that the record ends in `b`'s key order: a write only adds
 * a key at the end, so each kept key from the first one out of place on is removed and written again (with the new
 * keys, in `b`'s order). Empty when the order already comes out right; a node's own properties are never reordered
 */
function reorderedKeys(a: JsonRecord, b: JsonRecord): string[] {
    if (isNode(a) || isNode(b)) return [];
    const target = Object.keys(b);
    const written = [...Object.keys(a).filter((key) => key in b), ...target.filter((key) => !(key in a))];
    const first = target.findIndex((key, index) => written[index] !== key);
    return first < 0 ? [] : target.slice(first).filter((key) => key in a);
}

/**
 * The writes that turn `a` into `b` below `path`; a key that only `a` has is removed. False when writes cannot carry
 * it. With `reordered`, key order counts: a record (not a node) whose keys moved has the moved keys removed and
 * written again in the new order, and its path is added to `reordered`
 */
export function diffComplete(path: string, a: unknown, b: unknown, writes: PathWrite[], reordered?: string[]): boolean {
    if (deepEqual(a, b) && (reordered === undefined || sameKeyOrder(a, b))) return true;
    if (isRecord(a) && isRecord(b)) {
        const moved = reordered === undefined ? [] : reorderedKeys(a, b);
        if (moved.length > 0) reordered!.push(path);
        for (const key of Object.keys(a)) {
            if (key in b && !moved.includes(key)) continue;
            if (!SEGMENT.test(key)) return false;
            writes.push({ path: `${path}.${key}`, remove: true });
        }
        for (const key of Object.keys(b)) {
            if (!SEGMENT.test(key)) return false;
            const child = `${path}.${key}`;
            const value = b[key];
            if (!(key in a) || moved.includes(key)) {
                if (!isJson(value)) return false;
                writes.push({ path: child, value });
            } else if (!diffComplete(child, a[key], value, writes, reordered)) {
                return false;
            }
        }
        return writes.length <= MAX_WRITES;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((item, index) => diffComplete(`${path}.${index}`, item, b[index], writes, reordered));
    }
    if (TREE_ROOT.test(path) || !isJson(b)) return false;
    writes.push({ path, value: b });
    return writes.length <= MAX_WRITES;
}

/**
 * True when a write changes the component of a node or adds, changes or removes a `<-` link, or writes a value that
 * holds nodes or links. The runtime mounts a node (component defaults, composed components, links) only when the node
 * is written whole; such a write is lifted to a write of the node that owns it
 */
function mountsNodes(write: PathWrite): boolean {
    const key = write.path.slice(write.path.lastIndexOf('.') + 1);
    if (key === 'component' || key.startsWith('<-')) return true;
    return write.remove !== true && holdsNodeOrLink(write.value);
}

function holdsNodeOrLink(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(holdsNodeOrLink);
    if (!isRecord(value)) return false;
    return Object.entries(value).some(([key, item]) => key === 'component' || key.startsWith('<-') || holdsNodeOrLink(item));
}

function isNode(value: unknown): value is JsonRecord {
    return isRecord(value) && typeof value['component'] === 'string';
}

function isAtOrBelow(path: string, base: string): boolean {
    return path === base || path.startsWith(`${base}.`);
}

/** A node tree the writes change: the app node at `$.app`, or the root of a screen at `$.screens.<name>` */
interface Tree {
    readonly base: string;
    readonly root: unknown;
}

/**
 * The path and value of the node of a tree that a write below the tree's base belongs to: the written value when it
 * is a whole node, else the nearest node above the path. Undefined when the owner is the root node of the tree, which
 * only a load mounts
 */
function owningNode(trees: readonly Tree[], write: PathWrite): { path: string; value: JsonRecord } | undefined {
    if (write.remove !== true && isNode(write.value)) return { path: write.path, value: write.value };
    const tree = trees.find((candidate) => isAtOrBelow(write.path, candidate.base));
    if (tree === undefined) return undefined;
    const segments = write.path.slice(tree.base.length + 1).split('.');
    let owner: { path: string; value: JsonRecord } | undefined;
    let value: unknown = tree.root;
    for (let index = 0; index < segments.length - 1; index += 1) {
        value = isRecord(value) || Array.isArray(value) ? (value as Record<string, unknown>)[segments[index]!] : undefined;
        if (value === undefined) break;
        if (isNode(value)) owner = { path: `${tree.base}.${segments.slice(0, index + 1).join('.')}`, value };
    }
    return owner;
}

/**
 * The writes with each one that mounts nodes replaced by a write of its owning node whole, which the runtime mounts as
 * a load would; the other writes inside a lifted node are dropped, except the removal of the node's own path, which
 * stays before it (a key that moves is removed and written again, so it comes last in its record). 'load' when a change
 * belongs to the root node
 */
function liftNodeWrites(trees: readonly Tree[], writes: readonly PathWrite[]): PathWrite[] | 'load' {
    const owners: { path: string; value: JsonRecord }[] = [];
    for (const write of writes) {
        if (!mountsNodes(write)) continue;
        const owner = owningNode(trees, write);
        if (!owner) return 'load';
        if (owners.some((known) => isAtOrBelow(owner.path, known.path))) continue;
        for (let index = owners.length - 1; index >= 0; index -= 1) if (isAtOrBelow(owners[index]!.path, owner.path)) owners.splice(index, 1);
        owners.push(owner);
    }
    if (owners.length === 0) return [...writes];
    const rest = writes.filter((write) => !owners.some((owner) => isAtOrBelow(write.path, owner.path) && !(write.remove === true && write.path === owner.path)));
    return [...rest, ...owners.map((owner) => ({ path: owner.path, value: copy(owner.value) }))];
}

/**
 * Each screen of a document as the tree its root is (at `$.screens.<name>`, the path the runtime keeps it under) and the
 * rest of the screen, in order. Empty for a document without screens, undefined when a screen cannot be read
 */
function screenTrees(screens: Json | undefined): (Tree & { readonly rest: JsonRecord })[] | undefined {
    if (screens === undefined) return [];
    if (!isRecord(screens)) return undefined;
    const trees: (Tree & { readonly rest: JsonRecord })[] = [];
    for (const [name, screen] of Object.entries(screens)) {
        if (!SEGMENT.test(name) || !isRecord(screen)) return undefined;
        const { root, ...rest } = screen;
        trees.push({ base: `$.screens.${name}`, root, rest });
    }
    return trees;
}

/**
 * A document change as writes: the `app` tree and the root of each screen change through writes, anything else
 * (theme, locales, composed, the screens themselves or a screen's title, params or locales) is a full load. `data` is the synced state's. The order of a node's children counts (it is the order they render in):
 * children that moved are removed and written again. A reorder inside a node that is written whole would be merged
 * into the old order by the runtime store, so that is a full load
 */
export function planDocumentUpdate(previous: JsonRecord, next: JsonRecord): PathWrite[] | 'none' | 'load' {
    const { data: _previousData, app: previousApp, screens: previousScreens, ...previousRest } = previous;
    const { data: _nextData, app: nextApp, screens: nextScreens, ...nextRest } = next;
    if (!deepEqual(previousRest, nextRest)) return 'load';
    const previousTrees = screenTrees(previousScreens);
    const nextTrees = screenTrees(nextScreens);
    if (previousTrees === undefined || nextTrees === undefined) return 'load';
    if (previousTrees.length !== nextTrees.length || previousTrees.some((tree, index) => tree.base !== nextTrees[index]!.base || !deepEqual(tree.rest, nextTrees[index]!.rest))) return 'load';
    const writes: PathWrite[] = [];
    const reordered: string[] = [];
    if (!diffComplete('$.app', previousApp, nextApp, writes, reordered) || writes.length > MAX_WRITES) return 'load';
    for (const [index, tree] of nextTrees.entries()) {
        if (!diffComplete(tree.base, previousTrees[index]!.root, tree.root, writes, reordered) || writes.length > MAX_WRITES) return 'load';
    }
    const lifted = liftNodeWrites([{ base: '$.app', root: nextApp }, ...nextTrees], writes);
    if (lifted === 'load') return 'load';
    if (reordered.some((path) => lifted.some((write) => write.remove !== true && isAtOrBelow(path, write.path)))) return 'load';
    return lifted.length === 0 ? 'none' : lifted;
}
