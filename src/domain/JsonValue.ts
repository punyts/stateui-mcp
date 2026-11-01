/** Any value a StateUI document or state snapshot can hold. Plain and serialisable */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/** A JSON object. Key order is part of the value: it orders `children`, `options` and other keyed maps */
export interface JsonObject {
    readonly [key: string]: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
