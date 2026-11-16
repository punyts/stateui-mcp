import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const LAMP = deepFreeze({ name: 'Lamp', price: 30 });

let data: TempData;
let harness: InMemoryHarness;

async function records(dataset: string): Promise<Record<string, unknown>> {
    const read = await call(harness.client, 'ui_get', { kind: 'data', name: dataset });
    return (read.body['value'] as { records: Record<string, unknown> }).records;
}

async function revision(dataset: string): Promise<number> {
    return (await call(harness.client, 'ui_get', { kind: 'data', name: dataset })).body['revision'] as number;
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    const model = await call(harness.client, 'ui_model_write', {
        model: 'product',
        operations: [
            { op: 'set', field: 'name', type: 'string', required: true },
            { op: 'set', field: 'price', type: 'number', validators: { range: { min: 0 } } }
        ]
    });
    if (model.isError) throw new Error(JSON.stringify(model.body));
    const created = await call(harness.client, 'ui_data_write', { dataset: 'catalog', model: 'product', operations: [{ op: 'set', path: 'p1', value: LAMP }] });
    if (created.isError) throw new Error(JSON.stringify(created.body));
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_data_write', () => {
    it('should create a dataset on its first write with its model', async () => {
        // Act
        const stored = await call(harness.client, 'ui_get', { kind: 'data', name: 'catalog' });

        // Assert
        expect(stored.body['revision']).toBe(1);
        expect(stored.body['value']).toEqual({ model: 'product', records: { p1: LAMP } });
    });

    it('should add a record under a generated key that is never integer-like and return the key', async () => {
        // Act
        const result = await call(harness.client, 'ui_data_write', { dataset: 'catalog', operations: [{ op: 'add', value: { name: 'Chair', price: 80 } }] });

        // Assert
        expect(result.body).toMatchObject({ dataset: 'catalog', revision: 2, created: false });
        const [key] = result.body['added'] as string[];
        expect(key).toMatch(/^r[0-9a-f-]+$/);
        expect(Number.isInteger(Number(key))).toBe(false);
        expect((await records('catalog'))[key ?? '']).toEqual({ name: 'Chair', price: 80 });
    });

    it('should set, merge and remove records and fields', async () => {
        // Act
        const result = await call(harness.client, 'ui_data_write', {
            dataset: 'catalog',
            operations: [
                { op: 'set', path: 'p2', value: { name: 'Desk', price: 200 } },
                { op: 'set', path: 'p1.price', value: 35 },
                { op: 'merge', path: 'p2', value: { price: 180 } },
                { op: 'remove', path: 'p1.price' }
            ]
        });

        // Assert
        expect(result.body).toMatchObject({ revision: 2, added: [] });
        expect(await records('catalog')).toEqual({ p1: { name: 'Lamp' }, p2: { name: 'Desk', price: 180 } });
    });

    it('should refuse a record that does not fit the model with its key and field, and write nothing', async () => {
        // Act
        const result = await call(harness.client, 'ui_data_write', {
            dataset: 'catalog',
            operations: [
                { op: 'set', path: 'p2', value: { name: 'Desk', price: 200 } },
                { op: 'set', path: 'p1.price', value: -5 }
            ]
        });

        // Assert
        expect(result.body['error']).toBe('invalid-records');
        expect(result.body['errors']).toEqual([expect.objectContaining({ record: 'p1', field: 'price' })]);
        expect(await revision('catalog')).toBe(1);
        expect(await records('catalog')).toEqual({ p1: LAMP });
    });

    it('should conflict on a stale expectedRevision and apply to the newest records without one', async () => {
        // Arrange
        await call(harness.client, 'ui_data_write', { dataset: 'catalog', operations: [{ op: 'set', path: 'p1.price', value: 32 }] });

        // Act
        const stale = await call(harness.client, 'ui_data_write', { dataset: 'catalog', expectedRevision: 1, operations: [{ op: 'set', path: 'p1.price', value: 40 }] });
        const latest = await call(harness.client, 'ui_data_write', { dataset: 'catalog', operations: [{ op: 'set', path: 'p1.name', value: 'Desk lamp' }] });

        // Assert
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 2 });
        expect(latest.body).toMatchObject({ revision: 3 });
        expect(await records('catalog')).toEqual({ p1: { name: 'Desk lamp', price: 32 } });
    });

    it('should refuse a missing dataset without a model, a missing model, another model and misplaced fields', async () => {
        // Act
        const missing = await call(harness.client, 'ui_data_write', { dataset: 'catalogs', operations: [{ op: 'add', value: LAMP }] });
        const noModel = await call(harness.client, 'ui_data_write', { dataset: 'stock', model: 'products', operations: [{ op: 'add', value: LAMP }] });
        const otherModel = await call(harness.client, 'ui_data_write', { dataset: 'catalog', model: 'order', operations: [{ op: 'add', value: LAMP }] });
        const addPath = await call(harness.client, 'ui_data_write', { dataset: 'catalog', operations: [{ op: 'add', path: 'p3', value: LAMP }] });
        const noPath = await call(harness.client, 'ui_data_write', { dataset: 'catalog', operations: [{ op: 'remove' }] });

        // Assert
        expect(missing.body).toMatchObject({ error: 'not-found', argument: 'dataset', nearest: ['catalog'] });
        expect(noModel.body).toMatchObject({ error: 'not-found', argument: 'model', nearest: ['product'] });
        expect(otherModel.body).toMatchObject({ error: 'invalid-argument', argument: 'model' });
        expect(addPath.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].path' });
        expect(noPath.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].path' });
    });
});

describe('ui_data_query', () => {
    it('should return the window and the total: 12 records, window 5 at offset 10, gives 2 records of 12', async () => {
        // Arrange
        const operations = Array.from({ length: 11 }, (_, index) => ({ op: 'set', path: `p${index + 2}`, value: { name: `Item ${index + 2}`, price: index + 2 } }));
        await call(harness.client, 'ui_data_write', { dataset: 'catalog', operations });

        // Act
        const result = await call(harness.client, 'ui_data_query', { dataset: 'catalog', sort: 'price', window: { first: 10, count: 5 } });

        // Assert
        expect(result.body).toMatchObject({ dataset: 'catalog', first: 10, total: 12 });
        expect((result.body['records'] as { key: string }[]).map((row) => row.key)).toEqual(['p12', 'p1']);
    });

    it('should filter and sort descending', async () => {
        // Arrange
        await call(harness.client, 'ui_data_write', {
            dataset: 'catalog',
            operations: [
                { op: 'set', path: 'p2', value: { name: 'Chair', price: 80 } },
                { op: 'set', path: 'p3', value: { name: 'Desk', price: 200 } }
            ]
        });

        // Act
        const result = await call(harness.client, 'ui_data_query', { dataset: 'catalog', filter: '$record.price > 50', sort: '-price' });

        // Assert
        expect(result.body['records']).toEqual([
            { key: 'p3', record: { name: 'Desk', price: 200 } },
            { key: 'p2', record: { name: 'Chair', price: 80 } }
        ]);
        expect(result.body['total']).toBe(2);
    });

    it('should refuse a window over the limit, a filter that does not evaluate and a missing dataset', async () => {
        // Act
        const tooMany = await call(harness.client, 'ui_data_query', { dataset: 'catalog', window: { count: 500 } });
        const filter = await call(harness.client, 'ui_data_query', { dataset: 'catalog', filter: '$record.price >' });
        const missing = await call(harness.client, 'ui_data_query', { dataset: 'catalogs' });

        // Assert
        expect(tooMany.body).toMatchObject({ error: 'invalid-argument', argument: 'window.count' });
        expect(filter.body).toMatchObject({ error: 'invalid-argument', argument: 'filter' });
        expect(missing.body).toMatchObject({ error: 'not-found', argument: 'dataset' });
    });
});
