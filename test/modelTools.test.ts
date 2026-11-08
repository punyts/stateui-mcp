import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PartKind } from '../src/domain/partName.js';
import type { UiPartBodies } from '../src/domain/UiPart.js';
import { call, inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const CATALOG = deepFreeze({ model: 'product', records: { p1: { name: 'Lamp', price: 30 }, p2: { name: 'Chair' } } }) as unknown as UiPartBodies['data'];

/** A shop whose home screen shows the price of the first product */
const SHOP = deepFreeze({
    uses: { data: { products: { dataset: 'catalog' } } },
    start: 'home',
    app: { component: 'app' },
    screens: { home: { root: { component: 'text', _text: '', '<-_text': '$.data.products.p1.price' } } }
}) as unknown as UiPartBodies['apps'];

/** A module that totals the prices of the items it needs */
const PRICING = deepFreeze({
    needs: { items: { model: 'product' }, totals: { model: 'totals' } },
    params: {},
    rules: { total: { when: { path: '$.data.items' }, do: [{ command: 'set', target: '$.data.totals.net', value: "{{ sum($.data.items, 'price') }}" }] }, watch: { when: { path: '$.data.items.{id}.price' }, do: [{ command: 'set', target: '$.data.totals.net', value: 0 }] } }
}) as unknown as UiPartBodies['logic'];

let data: TempData;
let harness: InMemoryHarness;

async function write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K]): Promise<void> {
    const result = await harness.services.useCases.writePart!.execute({ kind, name, body });
    if (result.kind !== 'written') throw new Error(`${kind} ${name}: ${JSON.stringify(result)}`);
}

async function model(name: string): Promise<Record<string, unknown>> {
    return (await call(harness.client, 'ui_get', { kind: 'models', name })).body;
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    const created = await call(harness.client, 'ui_model_write', {
        model: 'product',
        operations: [
            { op: 'set', field: 'name', type: 'string', required: true },
            { op: 'set', field: 'price', type: 'number', validators: { range: { min: 0 } } }
        ]
    });
    if (created.isError) throw new Error(JSON.stringify(created.body));
    await call(harness.client, 'ui_model_write', { model: 'totals', operations: [{ op: 'set', field: 'net', type: 'number', default: 0 }] });
    await write('data', 'catalog', CATALOG);
    await write('apps', 'shop', SHOP);
    await write('logic', 'pricing', PRICING);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_model_write', () => {
    it('should create a model on its first write', async () => {
        // Act
        const part = await model('product');

        // Assert
        expect(part['revision']).toBe(1);
        expect(part['value']).toEqual({ fields: { name: { type: 'string', required: true }, price: { type: 'number', validators: { range: { min: 0 } } } } });
    });

    it('should remove a field and warn on the dataset that holds it, the app that links to it and the module that reads it, and still write', async () => {
        // Act
        const result = await call(harness.client, 'ui_model_write', { model: 'product', expectedRevision: 1, operations: [{ op: 'remove', field: 'price' }] });

        // Assert
        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ model: 'product', revision: 2, created: false, datasetWarnings: [{ dataset: 'catalog', keys: ['p1'], invalidCount: 1 }] });
        expect(result.body['readers']).toEqual([
            { kind: 'logic', name: 'pricing', paths: ['$.data.items.{id}.price'] },
            { kind: 'apps', name: 'shop', paths: ['$.data.products.p1.price'] }
        ]);
        expect((await model('product'))['value']).toEqual({ fields: { name: { type: 'string', required: true } } });
    });

    it('should refuse a default that fails its own validators and write nothing', async () => {
        // Act
        const result = await call(harness.client, 'ui_model_write', {
            model: 'product',
            expectedRevision: 1,
            operations: [{ op: 'set', field: 'stock', type: 'integer', default: -1, validators: { range: { min: 0 } } }]
        });

        // Assert
        expect(result.body['error']).toBe('invalid-model');
        expect(JSON.stringify(result.body['errors'])).toContain('fails its own validators');
        expect((await model('product'))['revision']).toBe(1);
    });

    it('should refuse an unknown type or validator with the allowed list', async () => {
        // Act
        const type = await call(harness.client, 'ui_model_write', { model: 'product', expectedRevision: 1, operations: [{ op: 'set', field: 'when', type: 'date' }] });
        const validator = await call(harness.client, 'ui_model_write', {
            model: 'product',
            expectedRevision: 1,
            operations: [{ op: 'set', field: 'code', type: 'string', validators: { regexp: '^A' } }]
        });
        const noType = await call(harness.client, 'ui_model_write', { model: 'product', expectedRevision: 1, operations: [{ op: 'set', field: 'code' }] });

        // Assert
        expect(type.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].type' });
        expect(type.body['message']).toContain('string, number, integer, boolean, array, object, any, url');
        expect(validator.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].validators' });
        expect(validator.body['allowed']).toContain('range');
        expect(noType.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].type' });
    });

    it('should refuse a missing field, a stale revision, an existing name and a missing model', async () => {
        // Act
        const field = await call(harness.client, 'ui_model_write', { model: 'product', expectedRevision: 1, operations: [{ op: 'remove', field: 'prise' }] });
        const stale = await call(harness.client, 'ui_model_write', { model: 'product', expectedRevision: 3, operations: [{ op: 'remove', field: 'price' }] });
        const duplicate = await call(harness.client, 'ui_model_write', { model: 'product', operations: [{ op: 'set', field: 'x', type: 'string' }] });
        const missing = await call(harness.client, 'ui_model_write', { model: 'prodcut', expectedRevision: 1, operations: [{ op: 'remove', field: 'price' }] });
        const misplaced = await call(harness.client, 'ui_model_write', { model: 'product', expectedRevision: 1, operations: [{ op: 'remove', field: 'price', type: 'number' }] });

        // Assert
        expect(field.body).toMatchObject({ error: 'invalid-operation', index: 0 });
        expect(field.body['message']).toContain('nearest: price');
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(duplicate.body['error']).toBe('duplicate-name');
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['product'] });
        expect(misplaced.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].type' });
    });
});
