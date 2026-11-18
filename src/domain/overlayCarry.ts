import { setCreatingParents } from './documentOperations.js';
import { resolveDocumentPath } from './DocumentPath.js';
import { isJsonObject } from './JsonValue.js';
import type { JsonObject, JsonValue } from './JsonValue.js';
import type { NodeOperation } from './nodeOperations.js';
import { TREE_ROOT, removePruning } from './nodeOperations.js';

/** A path of a tree operation (`root.children.a`) as an overlay addresses it (`children.a`), or undefined outside the root */
function overlayPath(path: string | undefined): string[] | undefined {
    if (path === undefined) return undefined;
    const segments = path.split('.');
    return segments[0] === TREE_ROOT ? segments.slice(1) : undefined;
}

/** Moves an overlay's entry for a node that a `move` moved, so its translations go with it */
function carryMove(overlay: JsonObject, operation: { readonly path: string; readonly to?: string }): JsonObject {
    const source = overlayPath(operation.path);
    if (source === undefined || source.length === 0) return overlay;
    const found = resolveDocumentPath(overlay, source);
    if (!found.found) return overlay;
    const target = operation.to === undefined ? source.slice(0, -1) : overlayPath(operation.to);
    if (target === undefined) return overlay;
    const removed = removePruning(overlay, source);
    if (!removed.ok) return overlay;
    const placed = setCreatingParents(removed.tree, [...target, source[source.length - 1] as string], found.value);
    return placed.ok ? (placed.document as JsonObject) : removed.tree;
}

/** Every leaf of an overlay, by its path */
function leaves(value: JsonValue, at: string[], into: string[][]): string[][] {
    if (isJsonObject(value)) for (const [key, inner] of Object.entries(value)) leaves(inner as JsonValue, [...at, key], into);
    else into.push(at);
    return into;
}

/** Drops each entry of an overlay whose node is no longer in the tree, and the objects that leaves empty */
function prune(overlay: JsonObject, root: JsonValue): JsonObject {
    let result = overlay;
    for (const path of leaves(overlay, [], [])) {
        if (path.length === 0 || resolveDocumentPath(root, path.slice(0, -1)).found) continue;
        const removed = removePruning(result, path);
        if (removed.ok) result = removed.tree;
    }
    return result;
}

/**
 * The locale overlays of a screen after a node write: a moved node's translations move with it, and the translations
 * of a node that is gone go too, so removing or moving a translated node does not leave an overlay naming a path that
 * no longer exists. A language left with no entry is dropped. `root` is the screen's tree after the write
 */
export function carryOverlays(locales: JsonObject, operations: readonly NodeOperation[], root: JsonValue): JsonObject {
    const carried: Record<string, JsonValue> = {};
    for (const [language, value] of Object.entries(locales)) {
        if (!isJsonObject(value)) {
            carried[language] = value as JsonValue;
            continue;
        }
        let overlay: JsonObject = value;
        for (const operation of operations) if (operation.op === 'move') overlay = carryMove(overlay, operation);
        overlay = prune(overlay, root);
        if (Object.keys(overlay).length > 0) carried[language] = overlay;
    }
    return carried as JsonObject;
}
