import { isJsonObject } from '../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../domain/JsonValue.js';
import type { ComponentEntry, ComponentToken } from './ports/ComponentCatalog.js';

/** The shape keys repeated elsewhere in the answer (summary, events, commands, tokens) or merged into it (properties) */
const SHAPE_KEYS_ANSWERED_ELSEWHERE = new Set(['summary', 'properties', 'events', 'commands', 'tokens']);

/** Property keys kept as they are when present */
const PROPERTY_KEYS_KEPT = ['requiredWhen', 'default', 'values', 'items', 'kind'] as const;

/** Boolean property flags kept only when true; `reflect` (whether the prop shows as an attribute for styling) is internal and dropped */
const PROPERTY_FLAGS_KEPT = ['required', 'runtime', 'row', 'exposed'] as const;

/**
 * One component as `ui_component_get` answers it: the catalog entry without what the agent already has or can't use.
 * The shape's properties come up to the top, each with only the keys that say something (no false flags or empty
 * validators), and the shape's copies of the summary, events, commands and tokens are dropped. The purpose phrases
 * are dropped too: `ui_components_search` returned them
 */
export type ComponentView = JsonObject;

function compactProperty(property: JsonValue): JsonValue {
    if (!isJsonObject(property)) return property;
    const compact: Record<string, JsonValue> = { type: property['type'] ?? 'unknown' };
    for (const flag of PROPERTY_FLAGS_KEPT) {
        if (property[flag] === true) compact[flag] = true;
    }
    for (const key of PROPERTY_KEYS_KEPT) {
        const value = property[key];
        if (value === undefined) continue;
        //a map's items sub-shape is properties too (table columns, select options): compact each the same way
        compact[key] = key === 'items' && isJsonObject(value) ? Object.fromEntries(Object.entries(value).map(([name, nested]) => [name, compactProperty(nested)])) : value;
    }
    const validators = property['validators'];
    if (isJsonObject(validators) && Object.keys(validators).length > 0) compact['validators'] = validators;
    return compact;
}

function tokensOf(tokens: readonly ComponentToken[]): JsonValue[] {
    return tokens.map((token) => ({ path: token.path, type: token.type, default: token.default }));
}

/** The compact answer for one component; see `ComponentView` */
export function toComponentView(entry: ComponentEntry): ComponentView {
    const head: Record<string, JsonValue> = {
        name: entry.name,
        tier: entry.tier,
        category: entry.category,
        size: entry.size,
        summary: entry.summary,
        example: entry.example
    };
    const tail: Record<string, JsonValue> = {};
    if (entry.tokens.length > 0) tail['tokens'] = tokensOf(entry.tokens);
    if (entry.locales.length > 0) tail['locales'] = [...entry.locales];

    if (entry.tier === 'composed') {
        return { ...head, tree: entry.tree, exposes: [...entry.exposes], ...tail };
    }

    const properties: Record<string, JsonValue> = {};
    const declared = entry.shape['properties'];
    if (isJsonObject(declared)) {
        for (const [name, property] of Object.entries(declared)) properties[name] = compactProperty(property);
    }
    const rest: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(entry.shape)) {
        if (SHAPE_KEYS_ANSWERED_ELSEWHERE.has(key) || value === false) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        rest[key] = value;
    }
    return {
        ...head,
        properties,
        ...rest,
        ...(entry.tier === 'root' && entry.slots.length > 0 && { slots: [...entry.slots] }),
        ...(entry.events.length > 0 && { events: [...entry.events] }),
        ...(entry.tier === 'root' && entry.commands.length > 0 && { commands: [...entry.commands] }),
        ...tail
    };
}
