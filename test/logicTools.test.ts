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

/** A shop with a persona bag of lines and totals, and a price field on its home screen */
const SHOP = deepFreeze({
    uses: { data: { bag: { model: 'bag-line', scope: 'persona' }, totals: { model: 'cart-totals', scope: 'persona' } } },
    start: 'home',
    app: { component: 'app' },
    screens: { home: { root: { component: 'form', children: { price: { component: 'textField', _label: 'Price' } } } } }
}) as unknown as UiPartBodies['apps'];

const TOTALS_RULE = deepFreeze({ when: { path: '$.data.bag' }, do: [{ command: 'set', target: '$.data.totals.net', value: "{{ sum($.data.bag, 'lineTotal') }}" }] });
const LINES_TABLE = deepFreeze({
    when: { path: '$.data.bag.{id}.qty' },
    rows: [{ do: [{ command: 'set', target: '$.data.bag.{id}.lineTotal', value: '{{ $value * 10 }}' }] }]
});

let data: TempData;
let harness: InMemoryHarness;

async function revisionOf(kind: string, name: string): Promise<unknown> {
    return (await call(harness.client, 'ui_get', { kind, name })).body['revision'];
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    for (const [model, fields] of [
        ['bag-line', { qty: { type: 'integer', required: true }, lineTotal: { type: 'number' } }],
        ['cart-totals', { net: { type: 'number', default: 0 } }]
    ] as const) {
        const written = await harness.services.useCases.writePart!.execute({ kind: 'models', name: model, body: { fields } as unknown as UiPartBodies['models'] });
        if (written.kind !== 'written') throw new Error(JSON.stringify(written));
    }
    const app = await harness.services.useCases.writePart!.execute({ kind: 'apps', name: 'shop', body: SHOP });
    if (app.kind !== 'written') throw new Error(JSON.stringify(app));
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_logic_write', () => {
    it('should place a rule over $.data.bag after the table that writes $.data.bag.*.lineTotal, with the paths each reads and writes', async () => {
        // Act
        const result = await call(harness.client, 'ui_logic_write', {
            app: 'shop',
            expectedRevision: 1,
            operations: [
                { op: 'set', unit: 'rules.totals', value: TOTALS_RULE },
                { op: 'set', unit: 'tables.lines', value: LINES_TABLE }
            ]
        });

        // Assert
        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ app: 'shop', revision: 2, created: false });
        expect(result.body['units']).toEqual([
            { group: 'rules', kind: 'rule', name: 'totals', position: 2, reads: ['$.data.bag'], writes: ['$.data.totals.net'] },
            { group: 'tables', kind: 'table', name: 'lines', position: 1, reads: ['$.data.bag.{id}.qty'], writes: ['$.data.bag.{id}.lineTotal'] }
        ]);
    });

    it('should remove a unit and refuse removing one that is not there', async () => {
        // Arrange
        await call(harness.client, 'ui_logic_write', { app: 'shop', expectedRevision: 1, operations: [{ op: 'set', unit: 'rules.totals', value: TOTALS_RULE }] });

        // Act
        const missing = await call(harness.client, 'ui_logic_write', { app: 'shop', expectedRevision: 2, operations: [{ op: 'remove', unit: 'rules.total' }] });
        const removed = await call(harness.client, 'ui_logic_write', { app: 'shop', expectedRevision: 2, operations: [{ op: 'remove', unit: 'rules.totals' }] });
        const stored = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' });

        // Assert
        expect(missing.body).toMatchObject({ error: 'invalid-operation', index: 0 });
        expect(missing.body['message']).toContain('nearest: totals');
        expect(removed.body).toMatchObject({ revision: 3, units: [] });
        expect((stored.body['value'] as Record<string, unknown>)['logic']).toBeUndefined();
    });

    it('should create a module with its needs and params on the first write, and refuse a unit naming a node with SUI-MODULE-NODE', async () => {
        // Act
        const created = await call(harness.client, 'ui_logic_write', {
            module: 'cart',
            needs: { bag: { model: 'bag-line' }, totals: { model: 'cart-totals' } },
            params: { taxRate: { type: 'number', default: 0 } },
            operations: [{ op: 'set', unit: 'rules.totals', value: TOTALS_RULE }]
        });
        const node = await call(harness.client, 'ui_logic_write', {
            module: 'cart',
            expectedRevision: 1,
            operations: [{ op: 'set', unit: 'rules.focus', value: { when: { path: '$.data.bag' }, do: [{ command: 'set', target: '$.screens.home.children.price.value', value: 0 }] } }]
        });

        // Assert
        expect(created.body).toMatchObject({ module: 'cart', revision: 1, created: true, units: [{ group: 'rules', name: 'totals', position: 1 }] });
        expect(node.body['error']).toBe('invalid-module');
        expect((node.body['errors'] as { code: string }[]).map((error) => error.code)).toContain('SUI-MODULE-NODE');
        expect(await revisionOf('logic', 'cart')).toBe(1);
    });

    it('should refuse a module whose needs omit a path it writes with SUI-MODULE-NEEDS', async () => {
        // Act
        const result = await call(harness.client, 'ui_logic_write', {
            module: 'cart',
            needs: { bag: { model: 'bag-line' } },
            operations: [{ op: 'set', unit: 'rules.totals', value: TOTALS_RULE }]
        });

        // Assert
        expect(result.body['error']).toBe('invalid-module');
        expect((result.body['errors'] as { code: string }[]).map((error) => error.code)).toContain('SUI-MODULE-NEEDS');
        expect((await call(harness.client, 'ui_get', { kind: 'logic', name: 'cart' })).body['error']).toBe('not-found');
    });

    it('should place an app unit in the order of the app assembled with its modules', async () => {
        // Arrange
        await call(harness.client, 'ui_logic_write', {
            module: 'cart',
            needs: { bag: { model: 'bag-line' }, totals: { model: 'cart-totals' } },
            operations: [{ op: 'set', unit: 'rules.totals', value: TOTALS_RULE }]
        });
        const configured = await call(harness.client, 'ui_app_configure', { name: 'shop', expectedRevision: 1, uses: { ...SHOP.uses, logic: { cart: {} } } });
        if (configured.isError) throw new Error(JSON.stringify(configured.body));

        // Act
        const result = await call(harness.client, 'ui_logic_write', { app: 'shop', expectedRevision: 2, operations: [{ op: 'set', unit: 'tables.lines', value: LINES_TABLE }] });

        // Assert
        expect(result.isError).toBe(false);
        expect(result.body['units']).toEqual([{ group: 'tables', kind: 'table', name: 'lines', position: 1, reads: ['$.data.bag.{id}.qty'], writes: ['$.data.bag.{id}.lineTotal'] }]);
    });

    it('should conflict on a stale expectedRevision and write nothing', async () => {
        // Act
        const stale = await call(harness.client, 'ui_logic_write', { app: 'shop', expectedRevision: 4, operations: [{ op: 'set', unit: 'rules.totals', value: TOTALS_RULE }] });

        // Assert
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(await revisionOf('apps', 'shop')).toBe(1);
    });

    it('should refuse a bad unit name, both or neither target, a missing app revision and needs on an app', async () => {
        // Act
        const unit = await call(harness.client, 'ui_logic_write', { app: 'shop', expectedRevision: 1, operations: [{ op: 'set', unit: 'rule.totals', value: TOTALS_RULE }] });
        const both = await call(harness.client, 'ui_logic_write', { app: 'shop', module: 'cart', expectedRevision: 1, operations: [] });
        const neither = await call(harness.client, 'ui_logic_write', { operations: [] });
        const noRevision = await call(harness.client, 'ui_logic_write', { app: 'shop', operations: [{ op: 'remove', unit: 'rules.totals' }] });
        const needs = await call(harness.client, 'ui_logic_write', { app: 'shop', expectedRevision: 1, needs: {}, operations: [] });

        // Assert
        expect(unit.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].unit' });
        expect(both.body['error']).toBe('invalid-argument');
        expect(neither.body['error']).toBe('invalid-argument');
        expect(noRevision.body).toMatchObject({ error: 'invalid-argument', argument: 'expectedRevision' });
        expect(needs.body).toMatchObject({ error: 'invalid-argument', argument: 'needs' });
    });

    it('should teach triggers, commands, tables, $previous, timers, call and $params in its description', async () => {
        // Act
        const { tools } = await harness.client.listTools();
        const description = tools.find((tool) => tool.name === 'ui_logic_write')?.description ?? '';

        // Assert
        for (const word of ['Triggers', 'Commands', 'Tables', '$previous', 'Timers', 'call', '$params']) expect(description).toContain(word);
    });
});
