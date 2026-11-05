import { isJsonObject } from '../domain/JsonValue.js';
import type { JsonValue } from '../domain/JsonValue.js';
import { isNodeValue } from '../domain/nodeDepth.js';
import type { UiDocument } from '../domain/UiApp.js';
import type { ComponentCatalog } from './ports/ComponentCatalog.js';

/** Names of the properties of a root component whose shape type is `icon` */
function iconProperties(catalog: ComponentCatalog, component: string): ReadonlySet<string> {
    const entry = catalog.get(component);
    const properties = entry?.tier === 'root' ? entry.shape['properties'] : undefined;
    if (!isJsonObject(properties)) return new Set();
    return new Set(
        Object.entries(properties)
            .filter(([, shape]) => isJsonObject(shape) && shape['type'] === 'icon')
            .map(([name]) => name)
    );
}

/**
 * The icon names a document sets: a property the component's shape types as `icon`, and any `icon` key (the
 * placement, option and item entries that carry one). Strings that are not icon names drop out later, when the
 * catalog is asked for path data
 */
export function collectIconNames(document: UiDocument, catalog: ComponentCatalog): Set<string> {
    const names = new Set<string>();
    const stack: JsonValue[] = [document];
    while (stack.length > 0) {
        const current = stack.pop() as JsonValue;
        if (Array.isArray(current)) {
            stack.push(...(current as readonly JsonValue[]));
        } else if (isJsonObject(current)) {
            const typed = isNodeValue(current) ? iconProperties(catalog, current.component) : new Set<string>();
            for (const [key, value] of Object.entries(current)) {
                if (typeof value === 'string' && value !== '' && (key === 'icon' || typed.has(key))) names.add(value);
                else stack.push(value);
            }
        }
    }
    return names;
}
