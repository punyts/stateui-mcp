import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiPartBodies } from '../src/domain/UiPart.js';
import { SAMPLE_FORM_AND_LIST_APP } from '../src/testing/sampleFormAndListApp.fixture.js';
import { SAMPLE_FORM_AND_LIST_OUTLINE } from '../src/testing/sampleFormAndListApp.outline.fixture.js';
import { call, inMemoryHarness, noBrowser, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

type Node = Record<string, unknown> & { children: Record<string, unknown> };
const SAMPLE = SAMPLE_FORM_AND_LIST_APP['app'] as unknown as Node;

/** The sample form-and-list app as an app of parts: its panel is the root of the one screen, its customers a shared dataset */
const CUSTOMERS_APP = deepFreeze({
    uses: { data: { customers: { dataset: 'customers' } } },
    start: 'home',
    app: { component: 'app' },
    screens: { home: { root: SAMPLE } }
}) as unknown as UiPartBodies['apps'];

/** A shop with a home and a detail screen, a persona bag and totals, and a machine over the totals' status */
const SHOP = deepFreeze({
    uses: { data: { bag: { model: 'bag-line', scope: 'persona' }, totals: { model: 'cart-totals', scope: 'persona' } } },
    start: 'home',
    app: { component: 'app' },
    screens: {
        home: { root: { component: 'form', children: { price: { component: 'textField', _label: 'Price' } } } },
        detail: { root: { component: 'panel', _title: 'Detail', children: { note: { component: 'text', _text: 'More' } } } }
    },
    logic: {
        machines: { flow: { state: '$.data.totals.status', initial: 'idle', transitions: [{ from: 'idle', to: 'busy', when: { path: '$.data.bag' } }] } }
    }
}) as unknown as UiPartBodies['apps'];

const TOTALS_RULE = deepFreeze({ when: { path: '$.data.bag' }, do: [{ command: 'set', target: '$.data.totals.net', value: "{{ sum($.data.bag, 'lineTotal') }}" }] });

let data: TempData;
let harness: InMemoryHarness;

async function write(kind: 'models' | 'data' | 'apps', name: string, body: unknown): Promise<void> {
    const written = await harness.services.useCases.writePart!.execute({ kind, name, body: body as UiPartBodies['apps'] });
    if (written.kind !== 'written') throw new Error(JSON.stringify(written));
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_tree with app', () => {
    it('should give the content outline of a one-screen app under content and logic', async () => {
        // Arrange
        await write('models', 'customer', { fields: { name: { type: 'string' } } });
        await write('data', 'customers', { model: 'customer', records: { c1: { name: 'Ada Lovelace' }, c2: { name: 'Grace Hopper' } } });
        await write('apps', 'customers', CUSTOMERS_APP);

        // Act
        const result = await call(harness.client, 'ui_tree', { app: 'customers', content: true, logic: true });

        // Assert
        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ app: 'customers', revision: 1, screens: ['home'] });
        const [first, ...rest] = SAMPLE_FORM_AND_LIST_OUTLINE.split('\n');
        expect(result.body['text']).toBe(
            ['app', `  ${first!.replace('panel', 'panel home')}`, ...rest.map((line) => `  ${line}`), '  toastRegion toasts "Notifications"'].join('\n')
        );
    });

    describe('with two screens', () => {
        beforeEach(async () => {
            await write('models', 'bag-line', { fields: { qty: { type: 'integer', required: true }, lineTotal: { type: 'number' } } });
            await write('models', 'cart-totals', { fields: { net: { type: 'number', default: 0 }, status: { type: 'string', default: 'idle' } } });
            await write('apps', 'shop', SHOP);
        });

        it('should list the paths of both screens under the app node, and its toasts', async () => {
            // Act
            const result = await call(harness.client, 'ui_tree', { app: 'shop' });

            // Assert
            expect(result.body['text']).toBe(
                [
                    '- app (app) $.app',
                    '  * home (form) $.screens.home',
                    '    - price (textField) $.screens.home.children.price',
                    '  * detail (panel) $.screens.detail',
                    '    - note (text) $.screens.detail.children.note',
                    '  * toasts (toastRegion) [slot] $.app.toasts'
                ].join('\n')
            );
            expect(result.body).toMatchObject({ screens: ['home', 'detail'], nodeCount: 6 });
        });

        it('should draw only the screen asked for under the app node, and start at a screen node', async () => {
            // Act
            const one = await call(harness.client, 'ui_tree', { app: 'shop', screen: 'detail', paths: false });
            const node = await call(harness.client, 'ui_tree', { app: 'shop', path: '$.screens.home.children.price' });

            // Assert
            expect(one.body['text']).toBe(['- app (app)', '  * detail (panel)', '    - note (text)', '  * toasts (toastRegion) [slot]'].join('\n'));
            expect(node.body['text']).toBe('- price (textField) $.screens.home.children.price');
        });

        it('should list a module\'s rule with its module name and the machine in its current state', async () => {
            // Arrange
            await call(harness.client, 'ui_logic_write', {
                module: 'cart',
                needs: { bag: { model: 'bag-line' }, totals: { model: 'cart-totals' } },
                operations: [{ op: 'set', unit: 'rules.totals', value: TOTALS_RULE }]
            });
            const configured = await call(harness.client, 'ui_app_configure', { name: 'shop', expectedRevision: 1, uses: { ...SHOP.uses, logic: { cart: {} } } });
            if (configured.isError) throw new Error(JSON.stringify(configured.body));
            const set = await call(harness.client, 'ui_state_set', { app: 'shop', path: '$.data.totals.status', value: 'busy' });
            if (set.isError) throw new Error(JSON.stringify(set.body));

            // Act
            const result = await call(harness.client, 'ui_tree', { app: 'shop', content: true, logic: true });

            // Assert
            const lines = String(result.body['text']).split('\n');
            expect(lines.slice(lines.indexOf('logic'))).toEqual([
                'logic',
                '  machine flow: busy (at $.data.totals.status)',
                '    idle → busy when $.data.bag',
                '  rule cart:totals when $.data.bag: set'
            ]);
        });

        it('should list what the page draws for the instance, opening the screen asked for first', async () => {
            // Arrange
            await harness.close();
            const open = vi.fn(async () => ({ rendered: true }));
            const rendered = vi.fn(async () => [
                { path: '$.app', component: 'app', visible: true },
                { path: '$.screens.detail', component: 'panel', visible: true }
            ]);
            harness = await inMemoryHarness(data.dir, { ...noBrowser, open, rendered });
            const id = (await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' })).body['id'];

            // Act
            const result = await call(harness.client, 'ui_tree', { app: 'shop', screen: 'detail', rendered: true, paths: false });
            const mixed = await call(harness.client, 'ui_tree', { app: 'shop', rendered: true, content: true });

            // Assert
            expect(result.body).toMatchObject({ app: 'shop', revision: 1, nodeCount: 2 });
            expect(open).toHaveBeenCalledWith(id, expect.any(Number), { screen: 'detail' });
            expect(rendered).toHaveBeenCalledWith(id, expect.any(Number), '$.app');
            expect(mixed.body).toMatchObject({ error: 'invalid-argument', argument: 'rendered' });
        });

        it('should refuse an unknown screen, naming the screens, a missing app and an unknown app', async () => {
            // Act
            const unknown = await call(harness.client, 'ui_tree', { app: 'shop', screen: 'cart' });
            const neither = await call(harness.client, 'ui_tree', {});
            const missing = await call(harness.client, 'ui_tree', { app: 'shp' });

            // Assert
            expect(unknown.body).toMatchObject({ error: 'invalid-argument', argument: 'screen', screens: ['home', 'detail'] });
            expect(neither.body['error']).toBe('invalid-argument');
            expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['shop'] });
        });
    });
});
