import { applyOperation, setCreatingParents } from './documentOperations.js';
import type { WriteOperation } from './documentOperations.js';
import { parseDocumentPath, resolveDocumentPath } from './DocumentPath.js';
import { isJsonObject } from './JsonValue.js';
import type { JsonObject, JsonValue } from './JsonValue.js';
import type { UiDocument } from './UiApp.js';
import type { UiBuildError } from './UiBuildError.js';

/** The key a tree is held under while it is written: node paths start with it (`root.children.hero`) */
export const TREE_ROOT = 'root';

/** The shell of an app, or one of its screens */
export type TreeTarget = { readonly kind: 'shell' } | { readonly kind: 'screen'; readonly screen: string };

/** Adds the node `value` to the `children` of the node at `path` under `key` (made from its component when absent), at the end or next to a sibling */
export interface AddOperation {
    readonly op: 'add';
    readonly path: string;
    readonly value: JsonValue;
    readonly key?: string;
    readonly before?: string;
    readonly after?: string;
}

/** One change to a tree: the operations of `ui_app_write`, on paths that start with `root`, and `add` */
export type NodeOperation = WriteOperation | AddOperation;

export type NodeOperationResult =
    | { readonly ok: true; readonly tree: JsonObject; readonly added?: string }
    | { readonly ok: false; readonly error: UiBuildError };

/** The state path of a tree's root at run time: `$.app` for the shell, `$.screens.{screen}` for a screen */
export function treeStatePath(target: TreeTarget): string {
    return target.kind === 'shell' ? '$.app' : `$.screens.${target.screen}`;
}

/**
 * A path given to a tree tool, made relative to the tree (`root...`). It may already start with `root`, or name the
 * tree's run-time path: `app...` for the shell, `screens.{screen}...` for the screen (a leading `$.` is allowed).
 * `undefined` for a path of another tree or of no tree
 */
export function treePath(text: string, target: TreeTarget): string | undefined {
    const plain = text === '$' ? '' : text.startsWith('$.') ? text.slice(2) : text;
    const segments = plain === '' ? [] : plain.split('.');
    if (segments[0] === TREE_ROOT) return plain;
    const anchor = target.kind === 'shell' ? ['app'] : ['screens', target.screen];
    if (anchor.some((segment, index) => segments[index] !== segment)) return undefined;
    return [TREE_ROOT, ...segments.slice(anchor.length)].join('.');
}

/** An error's state path in the tree's run-time form: `$.root.children.x` of a screen is `$.screens.home.children.x` */
export function withTreeStatePath(error: UiBuildError, target: TreeTarget): UiBuildError {
    const path = error.statePath;
    if (path === undefined || (path !== `$.${TREE_ROOT}` && !path.startsWith(`$.${TREE_ROOT}.`))) return error;
    return { ...error, statePath: treeStatePath(target) + path.slice(`$.${TREE_ROOT}`.length) };
}

function failure(code: string, message: string, statePath: string): NodeOperationResult {
    return { ok: false, error: { code, message, statePath } };
}

/** A free key for a new child: its component name, then `name2`, `name3`... */
export function childKey(component: string, taken: readonly string[]): string {
    const base = /^[A-Za-z][A-Za-z0-9_-]*$/.test(component) ? component : 'node';
    if (!taken.includes(base)) return base;
    let number = 2;
    while (taken.includes(`${base}${number}`)) number += 1;
    return `${base}${number}`;
}

function applyAdd(tree: JsonObject, operation: AddOperation): NodeOperationResult {
    const parsed = parseDocumentPath(operation.path);
    if (!parsed.ok) return failure('SUI-DOC-PATH', `Path "${operation.path}": ${parsed.reason}`, '$');
    const statePath = `$.${operation.path}`;
    const found = resolveDocumentPath(tree, parsed.path);
    if (!found.found || !isJsonObject(found.value) || typeof found.value['component'] !== 'string') {
        return failure('SUI-DOC-PATH', `add needs the path of a node to add a child to; there is no node at "${operation.path}"`, statePath);
    }
    const { value } = operation;
    if (!isJsonObject(value) || typeof value['component'] !== 'string') return failure('SUI-DOC-OPERATION', 'add needs a node value with a "component"', statePath);
    const children = found.value['children'];
    if (children !== undefined && !isJsonObject(children)) return failure('SUI-DOC-PATH', `The children of "${operation.path}" are not a keyed map`, `${statePath}.children`);
    const taken = Object.keys(children ?? {});
    const key = operation.key ?? childKey(value['component'], taken);
    if (taken.includes(key)) return failure('SUI-DOC-PATH', `"${operation.path}" already has a child "${key}"`, `${statePath}.children.${key}`);
    const at = `${operation.path}.children.${key}`;
    const set = setCreatingParents(tree, [...parsed.path, 'children', key], value);
    if (!set.ok) return set;
    if (operation.before === undefined && operation.after === undefined) return { ok: true, tree: set.document, added: at };
    const moved = applyOperation(set.document, {
        op: 'move',
        path: at,
        ...(operation.before !== undefined && { before: operation.before }),
        ...(operation.after !== undefined && { after: operation.after })
    });
    return moved.ok ? { ok: true, tree: moved.document, added: at } : moved;
}

/**
 * Applies one operation to `{ root: tree }` and returns the changed copy; the input is never changed. `add` also
 * returns the path of the new node. The other operations are `applyOperation`'s
 */
export function applyNodeOperation(holder: JsonObject, operation: NodeOperation): NodeOperationResult {
    if ((operation as { op?: unknown }).op === 'add') return applyAdd(holder, operation as AddOperation);
    const applied = applyOperation(holder as UiDocument, operation as WriteOperation);
    return applied.ok ? { ok: true, tree: applied.document } : applied;
}

/** Removes the value at `path` below `root` and every object on the way that it leaves empty */
export function removePruning(root: JsonObject, path: readonly string[]): NodeOperationResult {
    const removed = applyOperation(root as UiDocument, { op: 'remove', path: path.join('.') });
    if (!removed.ok) return removed;
    let result: JsonObject = removed.document;
    for (let depth = path.length - 1; depth > 0; depth -= 1) {
        const parent = path.slice(0, depth);
        const found = resolveDocumentPath(result, parent);
        if (!found.found || !isJsonObject(found.value) || Object.keys(found.value).length > 0) break;
        const pruned = applyOperation(result as UiDocument, { op: 'remove', path: parent.join('.') });
        if (!pruned.ok) break;
        result = pruned.document;
    }
    return { ok: true, tree: result };
}
