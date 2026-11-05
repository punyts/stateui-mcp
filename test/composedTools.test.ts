import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/** A price field: a text field whose label a user of the component may change */
const PRICE_FIELD = deepFreeze({ component: 'textField', _label: 'Price' });
const EXPOSES = deepFreeze([{ path: '_label', description: 'The label above the price' }]);
const SEARCH = deepFreeze({
    summary: 'A field for a price with its label',
    category: 'forms',
    purposes: ['enter a product price', 'edit the cost of an item', 'type an amount of money']
});

/** A shop whose home screen uses the price field with its own label */
const SHOP = deepFreeze({
    start: 'home',
    shell: { component: 'page', children: { main: { component: 'outlet' } } },
    screens: { home: { root: { component: 'price-field', _label: 'Unit price' } } }
}) as unknown as UiPartBodies['apps'];

let data: TempData;
let harness: InMemoryHarness;

async function stored(name: string): Promise<Record<string, unknown>> {
    return (await call(harness.client, 'ui_get', { kind: 'components', name })).body;
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_composed_write', () => {
    it('should create a searchable component with its search fields stored beside the tree, not in the assembled tree', async () => {
        // Act
        const result = await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: PRICE_FIELD, exposes: EXPOSES, ...SEARCH });
        await harness.services.useCases.writePart!.execute({ kind: 'apps', name: 'shop', body: SHOP });
        const assembled = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop', resolved: true });

        // Assert
        expect(result.body).toMatchObject({ name: 'price-field', revision: 1, created: true, searchable: true, appWarnings: [] });
        expect((await stored('price-field'))['value']).toEqual({ tree: PRICE_FIELD, exposes: EXPOSES, ...SEARCH });
        const composed = (assembled.body['value'] as { composed: Record<string, Record<string, unknown>> }).composed['price-field'];
        expect(composed?.['component']).toBe('textField');
        expect(composed).not.toHaveProperty('summary');
        expect(composed).not.toHaveProperty('category');
        expect(composed).not.toHaveProperty('purposes');
    });

    it('should accept a component without search fields and say it is found by name only', async () => {
        // Act
        const result = await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: PRICE_FIELD });

        // Assert
        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ searchable: false, note: expect.stringContaining('found by name only') });
    });

    it('should keep the search fields an update leaves out, and remove purposes given as []', async () => {
        // Arrange
        await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: PRICE_FIELD, exposes: EXPOSES, ...SEARCH });

        // Act
        const kept = await call(harness.client, 'ui_composed_write', { name: 'price-field', expectedRevision: 1, tree: { ...PRICE_FIELD, _label: 'Cost' } });
        const afterKept = await stored('price-field');
        const removed = await call(harness.client, 'ui_composed_write', { name: 'price-field', expectedRevision: 2, purposes: [] });
        const afterRemoved = await stored('price-field');

        // Assert
        expect(kept.body).toMatchObject({ revision: 2, searchable: true });
        expect(afterKept['value']).toEqual({ tree: { ...PRICE_FIELD, _label: 'Cost' }, exposes: EXPOSES, ...SEARCH });
        expect(removed.body).toMatchObject({ revision: 3, searchable: false });
        expect(afterRemoved['value']).toEqual({ tree: { ...PRICE_FIELD, _label: 'Cost' }, exposes: EXPOSES, summary: SEARCH.summary, category: SEARCH.category });
    });

    it('should refuse each search field that breaks its rule, naming the field, and write nothing', async () => {
        // Act
        const cases = [
            { summary: 'Two\nlines' },
            { summary: 'x'.repeat(121) },
            { category: 'widgets' },
            { purposes: ['too few', 'phrases'] },
            { purposes: ['enter a product price', 'y'.repeat(61), 'type an amount of money'] },
            { purposes: ['enter a product price', 'two\nlines', 'type an amount of money'] }
        ];
        const results = [];
        for (const fields of cases) results.push(await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: PRICE_FIELD, ...fields }));

        // Assert
        expect(results.map((result) => result.body['argument'])).toEqual(['summary', 'summary', 'category', 'purposes', 'purposes', 'purposes']);
        expect(results.every((result) => result.body['error'] === 'invalid-argument')).toBe(true);
        expect(results[2]?.body['allowed']).toContain('forms');
        expect((await stored('price-field'))['error']).toBe('not-found');
    });

    it('should accept repeated purpose phrases, which only the library forbids', async () => {
        // Act
        const result = await call(harness.client, 'ui_composed_write', {
            name: 'price-field',
            tree: PRICE_FIELD,
            ...SEARCH,
            purposes: ['enter a price', 'Enter a price', 'type an amount of money']
        });

        // Assert
        expect(result.body).toMatchObject({ searchable: true });
    });

    it('should refuse a component that contains itself', async () => {
        // Act
        const result = await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: { component: 'form', children: { inner: { component: 'price-field' } } } });

        // Assert
        expect(result.body['error']).toBe('invalid-component');
        expect((result.body['errors'] as { code: string }[]).map((error) => error.code)).toContain('SUI-NODE-CYCLE');
    });

    it('should refuse a name the library has, naming it', async () => {
        // Act
        const result = await call(harness.client, 'ui_composed_write', { name: 'button', tree: { component: 'textField', _label: 'Not a button' } });

        // Assert
        expect(result.body).toMatchObject({ error: 'invalid-name', argument: 'name', message: expect.stringContaining('"button" is a library component') });
    });

    it('should warn on an app the write breaks, naming it, and still write', async () => {
        // Arrange
        await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: PRICE_FIELD, exposes: EXPOSES });
        const app = await harness.services.useCases.writePart!.execute({ kind: 'apps', name: 'shop', body: SHOP });
        if (app.kind !== 'written') throw new Error(JSON.stringify(app));

        // Act
        const result = await call(harness.client, 'ui_composed_write', { name: 'price-field', expectedRevision: 1, tree: { component: 'text', _text: 'Price' }, exposes: [] });

        // Assert
        expect(result.isError).toBe(false);
        expect(result.body['revision']).toBe(2);
        expect((result.body['appWarnings'] as { app: string }[]).map((warning) => warning.app)).toEqual(['shop']);
    });

    it('should refuse a create without a tree, a duplicate, a stale revision and a missing component', async () => {
        // Arrange
        await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: PRICE_FIELD });

        // Act
        const noTree = await call(harness.client, 'ui_composed_write', { name: 'tag-field' });
        const duplicate = await call(harness.client, 'ui_composed_write', { name: 'price-field', tree: PRICE_FIELD });
        const stale = await call(harness.client, 'ui_composed_write', { name: 'price-field', expectedRevision: 2, ...SEARCH });
        const missing = await call(harness.client, 'ui_composed_write', { name: 'price-feild', expectedRevision: 1, ...SEARCH });

        // Assert
        expect(noTree.body).toMatchObject({ error: 'invalid-argument', argument: 'tree' });
        expect(duplicate.body['error']).toBe('duplicate-name');
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['price-field'] });
    });
});
