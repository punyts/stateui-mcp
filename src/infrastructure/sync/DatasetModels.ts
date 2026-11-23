import type { ServerWrite } from '@punyts/state-sync/authority';
import { checkRecord, readModel } from '@punyts/stateui-app/core';
import type { JsonValue as LibraryJsonValue, ModelPart } from '@punyts/stateui-app/core';
import type { PartChangeListener } from '../../application/IndexedUiPartRepository.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isAtOrBelow } from './dataWrites.js';

/** The value at `segments` below `target` after `op` writes `value` there; objects on the way are copied */
export function applyAt(target: JsonValue | undefined, segments: readonly string[], op: ServerWrite['op'], value: JsonValue | undefined): JsonValue | undefined {
    const [head, ...rest] = segments;
    if (head === undefined) {
        if (op === 'delete') return undefined;
        if (op === 'merge' && isJsonObject(target) && isJsonObject(value)) return { ...target, ...value };
        return value;
    }
    const copy: Record<string, JsonValue> = { ...(isJsonObject(target) ? target : {}) };
    const next = applyAt(copy[head], rest, op, value);
    if (next === undefined) delete copy[head];
    else copy[head] = next;
    return copy;
}

export function segmentsBetween(above: string, below: string): string[] {
    return below === above ? [] : below.slice(above.length + 1).split('.');
}

export function descend(value: JsonValue | undefined, segments: readonly string[]): JsonValue | undefined {
    let current = value;
    for (const segment of segments) current = isJsonObject(current) ? current[segment] : undefined;
    return current;
}

/**
 * Why writes leave records of a dataset invalid, or undefined: the writes that reach `base` (the records' map, at,
 * below or above it) are applied to the records `get` reads, and each record they touch is checked against the model.
 * Without a model nothing is checked but that the records are an object
 */
export function recordsReason(model: ModelPart | undefined, dataset: string, base: string, get: (path: string) => JsonValue | undefined, writes: readonly ServerWrite[]): string | undefined {
    let records = get(base);
    const touched = new Set<string>();
    let whole = false;
    for (const write of writes) {
        const value = write.value as JsonValue | undefined;
        if (isAtOrBelow(write.path, base)) {
            const [key] = segmentsBetween(base, write.path);
            records = applyAt(records, segmentsBetween(base, write.path), write.op, value);
            if (key === undefined) whole = true;
            else touched.add(key);
        } else if (isAtOrBelow(base, write.path)) {
            records = descend(applyAt(get(write.path), [], write.op, value), segmentsBetween(write.path, base));
            whole = true;
        }
    }
    if (!whole && touched.size === 0) return undefined;
    if (records !== undefined && !isJsonObject(records)) return `${base} holds the records of the dataset "${dataset}", so it must be an object`;
    if (model === undefined || records === undefined) return undefined;
    const errors = [];
    for (const key of whole ? Object.keys(records) : touched) {
        const record = (records as JsonObject)[key];
        if (record !== undefined) errors.push(...checkRecord(model, record as LibraryJsonValue, key));
    }
    return errors.length === 0 ? undefined : errors.map((error) => error.message).join('; ');
}

interface Entry {
    model: string | undefined;
    fields: ModelPart | undefined;
    loading: Promise<void>;
}

/**
 * The models of the owner's datasets, read from the stored parts and kept for synchronous checks: the dataset
 * authority's change handler and the instance's data gate check records with them (docs/design/statenet-requests.md,
 * R3b). A dataset is read the first time it is loaded, and again when its part or its model changes
 */
export class DatasetModels {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly parts: Pick<UiPartRepository, 'findByName'>) {}

    /** Follows part changes; called once the part repository that tells of them exists */
    watch(onChange: (listener: PartChangeListener) => () => void): () => void {
        return onChange((kind, name) => {
            if (kind === 'data' && this.entries.has(name)) this.reload(name);
            if (kind === 'models') for (const [dataset, entry] of this.entries) if (entry.model === name) this.reload(dataset);
        });
    }

    /** Reads a dataset's model, once; later calls wait for the read under way */
    load(dataset: string): Promise<void> {
        const entry = this.entries.get(dataset);
        if (entry !== undefined) return entry.loading;
        return this.reload(dataset);
    }

    /** The model a dataset's records are checked with now; undefined before `load`, or when there is none */
    fields(dataset: string): ModelPart | undefined {
        return this.entries.get(dataset)?.fields;
    }

    private reload(dataset: string): Promise<void> {
        const entry: Entry = this.entries.get(dataset) ?? { model: undefined, fields: undefined, loading: Promise.resolve() };
        this.entries.set(dataset, entry);
        entry.loading = entry.loading
            .then(async () => {
                const part = await this.parts.findByName('data', dataset);
                entry.model = part?.body.model;
                const model = entry.model === undefined ? undefined : await this.parts.findByName('models', entry.model);
                entry.fields = model === undefined ? undefined : readModel(model.body as unknown as LibraryJsonValue).model;
            })
            .catch(() => {
                entry.fields = undefined;
            });
        return entry.loading;
    }
}
