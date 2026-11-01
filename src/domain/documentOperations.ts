import { parseDocumentPath, resolveDocumentPath, toStatePath } from './DocumentPath.js';
import type { DocumentPath } from './DocumentPath.js';
import { isJsonObject } from './JsonValue.js';
import type { JsonObject, JsonValue } from './JsonValue.js';
import type { UiDocument } from './UiApp.js';
import type { UiBuildError } from './UiBuildError.js';

/** `value` replaces whatever is at `path`; a new key is appended to its object */
export interface SetOperation {
    readonly op: 'set';
    readonly path: string;
    readonly value: JsonValue;
}

/** Deletes the value at `path` */
export interface RemoveOperation {
    readonly op: 'remove';
    readonly path: string;
}

/** Deep-merges the object `value` into the value at `path`; `null` is a value, not a delete */
export interface MergeOperation {
    readonly op: 'merge';
    readonly path: string;
    readonly value: JsonValue;
}

/**
 * Moves the keyed entry at `path` (with its whole subtree) and keeps its key. `before` or `after` names a sibling
 * key to place it next to; `to` names another keyed map (such as `app.children.panel.children`) to move it into, at
 * the end unless `before` or `after` is given. Without `to`, `before` or `after` reorders inside the same map
 */
export interface MoveOperation {
    readonly op: 'move';
    readonly path: string;
    readonly to?: string;
    readonly before?: string;
    readonly after?: string;
}

/** One change to a document, addressed by a dotted path from the document root (`app.children.footer._title`) */
export type WriteOperation = SetOperation | RemoveOperation | MergeOperation | MoveOperation;

type ValueOperation = SetOperation | RemoveOperation | MergeOperation;

export type OperationResult =
    | { readonly ok: true; readonly document: UiDocument }
    | { readonly ok: false; readonly error: UiBuildError };

/** The names of the operations a write accepts, for messages */
export const WRITE_OPERATION_NAMES: readonly string[] = ['set', 'remove', 'merge', 'move'];

const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function failure(code: string, message: string, statePath: string): { ok: false; error: UiBuildError } {
    return { ok: false, error: { code, message, statePath } };
}

type Leaf =
    | { readonly kind: 'value'; readonly value: JsonValue }
    | { readonly kind: 'remove' }
    | { readonly kind: 'error'; readonly message: string };

type Edited = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly error: UiBuildError };

interface Edit {
    readonly path: DocumentPath;
    /** Decides the new state of the entry at the end of the path; `existing` is `undefined` when there is none */
    readonly leaf: (existing: JsonValue | undefined) => Leaf;
    /** When set, a missing parent is created as an empty object instead of being an error */
    readonly createParents: boolean;
}

function pathError(message: string, path: DocumentPath, index: number): Edited {
    return failure('SUI-DOC-PATH', message, toStatePath(path.slice(0, index + 1)));
}

/** Rebuilds an object with `key` replaced in place, appended when new, or dropped when `next` is `undefined` */
function withEntry(object: JsonObject, key: string, next: JsonValue | undefined): JsonObject {
    const entries = Object.entries(object);
    const position = entries.findIndex(([name]) => name === key);
    if (next === undefined) return Object.fromEntries(entries.filter(([name]) => name !== key));
    if (position < 0) return Object.fromEntries([...entries, [key, next]]);
    return Object.fromEntries(entries.map(([name, value]): [string, JsonValue] => (name === key ? [key, next] : [name, value])));
}

function editObjectEntry(object: JsonObject, edit: Edit, index: number): Edited {
    const key = edit.path[index] as string;
    const exists = Object.hasOwn(object, key);
    if (index < edit.path.length - 1) {
        let child: JsonValue;
        if (exists) child = object[key] as JsonValue;
        else if (edit.createParents) child = {};
        else return pathError(`Nothing at "${key}": the path goes through a missing parent`, edit.path, index);
        const edited = editAt(child, edit, index + 1);
        return edited.ok ? { ok: true, value: withEntry(object, key, edited.value) } : edited;
    }
    const leaf = edit.leaf(exists ? (object[key] as JsonValue) : undefined);
    if (leaf.kind === 'error') return pathError(leaf.message, edit.path, index);
    return { ok: true, value: withEntry(object, key, leaf.kind === 'remove' ? undefined : leaf.value) };
}

function editArrayEntry(items: readonly JsonValue[], edit: Edit, index: number): Edited {
    const key = edit.path[index] as string;
    const position = ARRAY_INDEX.test(key) ? Number(key) : -1;
    if (index < edit.path.length - 1) {
        if (position < 0 || position >= items.length) {
            return pathError(`Nothing at "${key}": the path goes through a missing parent`, edit.path, index);
        }
        const edited = editAt(items[position] as JsonValue, edit, index + 1);
        if (!edited.ok) return edited;
        return { ok: true, value: items.map((item, at) => (at === position ? edited.value : item)) };
    }
    if (position < 0 || position > items.length) return pathError(`"${key}" is not a position in the list`, edit.path, index);
    const leaf = edit.leaf(position < items.length ? (items[position] as JsonValue) : undefined);
    if (leaf.kind === 'error') return pathError(leaf.message, edit.path, index);
    if (leaf.kind === 'remove') return { ok: true, value: items.filter((_item, at) => at !== position) };
    if (position === items.length) return { ok: true, value: [...items, leaf.value] };
    return { ok: true, value: items.map((item, at) => (at === position ? leaf.value : item)) };
}

function editAt(container: JsonValue, edit: Edit, index: number): Edited {
    if (Array.isArray(container)) return editArrayEntry(container as readonly JsonValue[], edit, index);
    if (isJsonObject(container)) return editObjectEntry(container, edit, index);
    return pathError(`The value at "${edit.path[index - 1] as string}" is not an object or a list`, edit.path, index - 1);
}

/**
 * Deep-merges `source` into `target`: objects merge key by key (existing keys keep their position, new keys are
 * appended in the order given); arrays, `null` and every other value replace. Neither argument is changed
 */
export function mergeValues(target: JsonValue | undefined, source: JsonObject): JsonObject {
    if (!isJsonObject(target)) return source;
    const merged: [string, JsonValue][] = Object.entries(target).map(([key, existing]): [string, JsonValue] => {
        if (!Object.hasOwn(source, key)) return [key, existing];
        const incoming = source[key] as JsonValue;
        return [key, isJsonObject(incoming) && isJsonObject(existing) ? mergeValues(existing, incoming) : incoming];
    });
    for (const [key, incoming] of Object.entries(source)) {
        if (!Object.hasOwn(target, key)) merged.push([key, incoming]);
    }
    return Object.fromEntries(merged);
}

function editDocument(root: JsonObject, edit: Edit): OperationResult {
    const edited = editAt(root, edit, 0);
    if (!edited.ok) return edited;
    return { ok: true, document: edited.value as JsonObject };
}

/**
 * Sets `value` at `path` below `root`, creating missing parent objects on the way. A parent that exists and is not
 * an object or list is an error. The empty path replaces `root` and needs an object. Used for the sparse state
 * snapshot, where parents are created as values arrive
 */
export function setCreatingParents(root: JsonObject, path: DocumentPath, value: JsonValue): OperationResult {
    if (path.length === 0) {
        if (!isJsonObject(value)) return failure('SUI-DOC-OPERATION', 'The root value must be an object', '$');
        return { ok: true, document: value };
    }
    return editDocument(root, { path, leaf: () => ({ kind: 'value', value }), createParents: true });
}

function applyAtRoot(document: UiDocument, operation: ValueOperation): OperationResult {
    if (operation.op === 'remove') return failure('SUI-DOC-PATH', 'The document root cannot be removed', '$');
    if (!isJsonObject(operation.value)) {
        return failure('SUI-DOC-OPERATION', `${operation.op} at the document root needs an object value`, '$');
    }
    return { ok: true, document: operation.op === 'set' ? operation.value : mergeValues(document, operation.value) };
}

function leafFor(operation: ValueOperation, path: DocumentPath): Edit['leaf'] {
    if (operation.op === 'remove') {
        return (existing) =>
            existing === undefined ? { kind: 'error', message: `Nothing to remove at "${path.join('.')}"` } : { kind: 'remove' };
    }
    if (operation.op === 'set') return () => ({ kind: 'value', value: operation.value });
    const source = operation.value;
    return (existing) => ({ kind: 'value', value: mergeValues(existing, source as JsonObject) });
}

function startsWith(path: DocumentPath, prefix: DocumentPath): boolean {
    return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/** The checks of a move that need no document: which arguments are present and that the entry can move at all */
function checkMoveShape(operation: Readonly<Record<string, unknown>>): { readonly error: UiBuildError } | { readonly source: DocumentPath } {
    const { path, to, before, after } = operation;
    if (typeof path !== 'string') return failure('SUI-DOC-PATH', 'move needs a path', '$');
    for (const [name, value] of [['to', to], ['before', before], ['after', after]] as const) {
        if (value !== undefined && typeof value !== 'string') return failure('SUI-DOC-OPERATION', `move: ${name} must be a string`, '$');
    }
    if (before !== undefined && after !== undefined) return failure('SUI-DOC-OPERATION', 'move takes before or after, not both', '$');
    if (to === undefined && before === undefined && after === undefined) {
        return failure('SUI-DOC-OPERATION', 'move needs to, before or after: it must say where the entry goes', '$');
    }
    const parsed = parseDocumentPath(path);
    if (!parsed.ok) return failure('SUI-DOC-PATH', `Path "${path}": ${parsed.reason}`, '$');
    if (parsed.path.length === 0) return failure('SUI-DOC-PATH', 'The document root cannot be moved', '$');
    if (parsed.path.length === 1 && parsed.path[0] === 'app') return failure('SUI-DOC-PATH', 'The root app cannot be moved', '$.app');
    return { source: parsed.path };
}

/**
 * Moves a keyed entry: it is taken out of its map, then put into the target map (its own, or the one `to` names)
 * next to the sibling `before` or `after` names, or at the end. The entry keeps its key and subtree. The target is
 * read after the removal, so a node can move up to an ancestor map and a reorder inside one map is the same code.
 * The input is never changed; every failure returns an error and no document
 */
function applyMove(document: UiDocument, operation: Readonly<Record<string, unknown>>): OperationResult {
    const shape = checkMoveShape(operation);
    if ('error' in shape) return { ok: false, error: shape.error };
    const source = shape.source;
    const key = source[source.length - 1] as string;
    const parentPath = source.slice(0, -1);
    const to = operation['to'] as string | undefined;
    const before = operation['before'] as string | undefined;
    const after = operation['after'] as string | undefined;

    const located = resolveDocumentPath(document, source);
    if (!located.found) {
        return failure('SUI-DOC-PATH', `Nothing to move at "${source.join('.')}"`, toStatePath(source.slice(0, located.missingAt + 1)));
    }
    const parent = resolveDocumentPath(document, parentPath);
    if (!parent.found || !isJsonObject(parent.value)) {
        return failure('SUI-DOC-PATH', `"${key}" is in a list, not a keyed map, so it cannot be moved by key`, toStatePath(source));
    }

    let targetPath: DocumentPath = parentPath;
    if (to !== undefined) {
        const parsedTo = parseDocumentPath(to);
        if (!parsedTo.ok) return failure('SUI-DOC-PATH', `Path "${to}": ${parsedTo.reason}`, '$');
        if (parsedTo.path.length === 0) return failure('SUI-DOC-PATH', 'to must name a keyed map, not the document root', '$');
        targetPath = parsedTo.path;
        if (startsWith(targetPath, source)) {
            return failure('SUI-DOC-PATH', `"${source.join('.')}" cannot be moved into its own subtree`, toStatePath(targetPath));
        }
    }

    const removed = editDocument(document, { path: source, leaf: () => ({ kind: 'remove' }), createParents: false });
    if (!removed.ok) return removed;
    const target = resolveDocumentPath(removed.document, targetPath);
    if (!target.found) {
        return failure('SUI-DOC-PATH', `Nothing at "${targetPath.join('.')}": the map to move into does not exist`, toStatePath(targetPath.slice(0, target.missingAt + 1)));
    }
    if (!isJsonObject(target.value)) {
        return failure('SUI-DOC-PATH', `"${targetPath.join('.')}" is not a keyed map`, toStatePath(targetPath));
    }
    if (Object.hasOwn(target.value, key)) {
        return failure('SUI-DOC-PATH', `The key "${key}" already exists at "${targetPath.join('.')}"`, toStatePath([...targetPath, key]));
    }

    const entries = Object.entries(target.value);
    const anchor = before ?? after;
    let position = entries.length;
    if (anchor !== undefined) {
        const siblingAt = entries.findIndex(([name]) => name === anchor);
        if (siblingAt < 0) {
            return failure('SUI-DOC-PATH', `No sibling "${anchor}" at "${targetPath.join('.')}" to place "${key}" next to`, toStatePath([...targetPath, anchor]));
        }
        position = before !== undefined ? siblingAt : siblingAt + 1;
    }
    const moved: [string, JsonValue] = [key, located.value];
    const reordered = Object.fromEntries([...entries.slice(0, position), moved, ...entries.slice(position)]);
    if (targetPath.length === 0) return { ok: true, document: reordered };
    return editDocument(removed.document, { path: targetPath, leaf: () => ({ kind: 'value', value: reordered }), createParents: false });
}

/**
 * Applies one operation to a document and returns the changed copy; the input is never changed. A failure carries
 * a `SUI-DOC-OPERATION` error (unknown operation, missing or wrong value) or a `SUI-DOC-PATH` error (a path that
 * does not parse, goes through a missing parent, or removes what is not there) with the state path it concerns.
 * `set` replaces in place or appends a new key; `merge` creates the key when it is missing
 */
export function applyOperation(document: UiDocument, operation: WriteOperation): OperationResult {
    const name: unknown = (operation as { op?: unknown }).op;
    if (name !== 'set' && name !== 'remove' && name !== 'merge' && name !== 'move') {
        return failure(
            'SUI-DOC-OPERATION',
            `Unknown operation "${String(name)}"; use ${WRITE_OPERATION_NAMES.join(', ')}`,
            '$'
        );
    }
    if (name === 'move') return applyMove(document, operation as unknown as Readonly<Record<string, unknown>>);
    const edit = operation as ValueOperation;
    const text: unknown = (operation as { path?: unknown }).path;
    if (typeof text !== 'string') return failure('SUI-DOC-PATH', `${name} needs a path`, '$');
    if (edit.op !== 'remove') {
        const value: unknown = (operation as { value?: unknown }).value;
        if (value === undefined) return failure('SUI-DOC-OPERATION', `${name} needs a value`, '$');
        if (edit.op === 'merge' && !isJsonObject(value)) {
            return failure('SUI-DOC-OPERATION', 'merge needs an object value', toStatePath(text === '' ? [] : text.split('.')));
        }
    }

    const parsed = parseDocumentPath(text);
    if (!parsed.ok) return failure('SUI-DOC-PATH', `Path "${text}": ${parsed.reason}`, '$');
    if (parsed.path.length === 0) return applyAtRoot(document, edit);
    return editDocument(document, { path: parsed.path, leaf: leafFor(edit, parsed.path), createParents: false });
}
