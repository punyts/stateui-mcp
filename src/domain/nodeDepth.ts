import { isJsonObject } from './JsonValue.js';
import type { JsonObject, JsonValue } from './JsonValue.js';

/** A node is an object with a string `component` */
export function isNodeValue(value: unknown): value is JsonObject & { readonly component: string } {
    return isJsonObject(value) && typeof value['component'] === 'string';
}

/** How many entries the `children` map of a node holds; zero when it has none */
export function childCount(node: JsonObject): number {
    const children = node['children'];
    return isJsonObject(children) ? Object.keys(children).length : 0;
}

function limit(value: JsonValue, level: number, depth: number): JsonValue {
    if (Array.isArray(value)) return (value as readonly JsonValue[]).map((item) => limit(item, level, depth));
    if (!isJsonObject(value)) return value;
    const entries = Object.entries(value).map(([key, item]): [string, JsonValue] => {
        if (isNodeValue(value) && key === 'children' && isJsonObject(item)) {
            const children = Object.entries(item).map(([childKey, child]): [string, JsonValue] => {
                if (!isNodeValue(child)) return [childKey, child];
                if (level + 1 > depth) return [childKey, { component: child.component, childCount: childCount(child) }];
                return [childKey, limit(child, level + 1, depth)];
            });
            return [key, Object.fromEntries(children)];
        }
        return [key, limit(item, level, depth)];
    });
    return Object.fromEntries(entries);
}

/**
 * Keeps `depth` levels of `children` below `node`. A node deeper than that comes back as
 * `{ component, childCount }`. Nodes held by a slot (`footer`, `row`) stay on the level of their parent.
 * The input is not changed
 */
export function limitNodeDepth(node: JsonObject, depth: number): JsonObject {
    return limit(node, 0, depth) as JsonObject;
}
