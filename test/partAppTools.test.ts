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

const STORE = deepFreeze({ tokens: { color: { accent: { base: '#204080' } } } }) as unknown as UiPartBodies['themes'];
const PRODUCT = deepFreeze({ fields: { name: { type: 'string', required: true }, price: { type: 'number' } } }) as unknown as UiPartBodies['models'];
const CATALOG = deepFreeze({ model: 'product', records: { p1: { name: 'Lamp', price: 30 } } }) as unknown as UiPartBodies['data'];
const PRICING = deepFreeze({ needs: { items: { model: 'product' } }, params: { taxRate: { type: 'number', default: 0 } } }) as unknown as UiPartBodies['logic'];
const HOME_ROOT = deepFreeze({ component: 'panel', children: { header: { component: 'text', _text: 'Shop' } } });
const TOASTS = deepFreeze({ component: 'toastRegion', messages: { saved: { tone: 'success', _title: 'Saved' } } });

let data: TempData;
let harness: InMemoryHarness;

async function write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K]): Promise<void> {
    const result = await harness.services.useCases.writePart!.execute({ kind, name, body });
    if (result.kind !== 'written') throw new Error(`${kind} ${name}: ${JSON.stringify(result)}`);
}

async function createShop(): Promise<void> {
    const created = await call(harness.client, 'ui_app_create', {
        name: 'shop',
        title: 'Corner shop',
        themes: ['store'],
        data: { products: { dataset: 'catalog' } },
        home: HOME_ROOT
    });
    if (created.isError) throw new Error(JSON.stringify(created.body));
}

async function appBody(name: string): Promise<Record<string, unknown>> {
    const read = await call(harness.client, 'ui_get', { kind: 'apps', name });
    return read.body['value'] as Record<string, unknown>;
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    await write('themes', 'store', STORE);
    await write('models', 'product', PRODUCT);
    await write('data', 'catalog', CATALOG);
    await write('logic', 'pricing', PRICING);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_app_create', () => {
    it('should create an app of parts with its uses, the app node and a home start screen', async () => {
        // Act
        const created = await call(harness.client, 'ui_app_create', {
            name: 'shop',
            title: 'Corner shop',
            themes: ['store'],
            data: { products: { dataset: 'catalog' }, items: { dataset: 'catalog' } },
            logic: { pricing: { params: { taxRate: 0.08 } } },
            app: { toasts: TOASTS },
            home: HOME_ROOT
        });
        const body = await appBody('shop');
        const validated = await call(harness.client, 'ui_validate', { app: 'shop' });

        // Assert
        expect(created.isError).toBe(false);
        expect(created.body).toMatchObject({ name: 'shop', revision: 1, start: 'home', warnings: [] });
        expect(created.body['id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(body).toEqual({
            title: 'Corner shop',
            uses: {
                themes: ['store'],
                data: { products: { dataset: 'catalog' }, items: { dataset: 'catalog' } },
                logic: { pricing: { params: { taxRate: 0.08 } } }
            },
            start: 'home',
            app: { _title: 'Corner shop', toasts: TOASTS, component: 'app' },
            screens: { home: { title: 'Home', root: HOME_ROOT } }
        });
        expect(validated.body).toMatchObject({ app: 'shop', valid: true });
    });

    it('should name each missing part with the nearest names and create nothing', async () => {
        // Act
        const result = await call(harness.client, 'ui_app_create', {
            name: 'shop',
            themes: ['stor'],
            data: { products: { dataset: 'catalgo' } }
        });
        const apps = await call(harness.client, 'ui_list', { kind: 'apps' });

        // Assert
        expect(result.body).toMatchObject({
            error: 'not-found',
            missing: [
                { kind: 'themes', name: 'stor', nearest: ['store'] },
                { kind: 'data', name: 'catalgo', nearest: ['catalog'] }
            ]
        });
        expect(result.body['message']).toContain('no theme "stor" (nearest: store)');
        expect(apps.body).toMatchObject({ count: 0 });
    });

    it('should create a bare panel home screen and an app node with the title when only a name and title are given', async () => {
        // Act
        const created = await call(harness.client, 'ui_app_create', { name: 'shop', title: 'Shop' });
        const body = await appBody('shop');

        // Assert
        expect(created.isError).toBe(false);
        expect(body).toEqual({ title: 'Shop', start: 'home', app: { _title: 'Shop', component: 'app' }, screens: { home: { title: 'Home', root: { component: 'panel' } } } });
    });

    it('should refuse an app node of another component and a home screen with an unknown component, creating nothing', async () => {
        // Act
        const other = await call(harness.client, 'ui_app_create', { name: 'shop', app: { component: 'page' } });
        const unknown = await call(harness.client, 'ui_app_create', { name: 'shop', home: { component: 'nothingLikeThis' } });
        const apps = await call(harness.client, 'ui_list', { kind: 'apps' });

        // Assert
        expect(other.body).toMatchObject({ error: 'invalid-argument', argument: 'app.component' });
        expect(unknown.body['error']).toBe('invalid-app');
        expect(apps.body).toMatchObject({ count: 0 });
    });

    it('should refuse a module whose need is not bound and name the module', async () => {
        // Act
        const result = await call(harness.client, 'ui_app_create', { name: 'shop', logic: { pricing: { params: {} } }, home: HOME_ROOT });

        // Assert
        expect(result.body['error']).toBe('invalid-app');
        expect(result.body['errors']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SUI-USES-NEEDS', part: { kind: 'logic', name: 'pricing' } })]));
    });

    it('should refuse a home pattern the library does not have', async () => {
        // Act
        const result = await call(harness.client, 'ui_app_create', { name: 'shop', home: { pattern: 'top-nav', params: { title: 'Shop' } } });

        // Assert
        expect(result.body).toMatchObject({ error: 'invalid-argument', argument: 'home' });
        expect(result.body['message']).toContain('No such pattern: "top-nav"');
    });

    it('should refuse a document, a home that is no node, a sync mode and a bad name', async () => {
        // Act
        const both = await call(harness.client, 'ui_app_create', { name: 'shop', document: {}, home: HOME_ROOT });
        const notNode = await call(harness.client, 'ui_app_create', { name: 'shop', home: { title: 'Shop' } });
        const persisted = await call(harness.client, 'ui_app_create', { name: 'shop', sync: 'persisted', home: HOME_ROOT });
        const badName = await call(harness.client, 'ui_app_create', { name: 'Corner Shop', home: HOME_ROOT });

        // Assert
        expect(both.body).toMatchObject({ error: 'invalid-argument', argument: 'document' });
        expect(notNode.body).toMatchObject({ error: 'invalid-argument', argument: 'home' });
        expect(persisted.body).toMatchObject({ error: 'invalid-argument', argument: 'sync' });
        expect(badName.body).toMatchObject({ error: 'invalid-name', argument: 'name' });
    });

    it('should refuse a duplicate app name', async () => {
        // Arrange
        await createShop();

        // Act
        const result = await call(harness.client, 'ui_app_create', { name: 'shop', home: HOME_ROOT });

        // Assert
        expect(result.body['error']).toBe('duplicate-name');
    });
});

describe('ui_app_configure', () => {
    beforeEach(createShop);

    it('should change only the title and the app node title, and keep every other field byte-equal', async () => {
        // Arrange
        const before = await appBody('shop');

        // Act
        const result = await call(harness.client, 'ui_app_configure', { name: 'shop', expectedRevision: 1, title: 'Lamp shop' });
        const after = await appBody('shop');

        // Assert
        expect(result.body).toEqual({ name: 'shop', revision: 2, warnings: [] });
        const { title: oldTitle, app: oldApp, ...oldRest } = before;
        const { title: newTitle, app: newApp, ...newRest } = after;
        expect([oldTitle, newTitle]).toEqual(['Corner shop', 'Lamp shop']);
        expect(newApp).toEqual({ ...(oldApp as object), _title: 'Lamp shop' });
        expect(JSON.stringify(newRest)).toBe(JSON.stringify(oldRest));
    });

    it('should check a new uses as a whole', async () => {
        // Act
        const unbound = await call(harness.client, 'ui_app_configure', {
            name: 'shop',
            expectedRevision: 1,
            uses: { themes: ['store'], logic: { pricing: { params: {} } } }
        });
        const missing = await call(harness.client, 'ui_app_configure', { name: 'shop', expectedRevision: 1, uses: { themes: ['shop-theme'] } });
        const bound = await call(harness.client, 'ui_app_configure', {
            name: 'shop',
            expectedRevision: 1,
            uses: { themes: ['store'], data: { items: { dataset: 'catalog' } }, logic: { pricing: { params: { taxRate: 0.2 } } } }
        });

        // Assert
        expect(unbound.body).toMatchObject({ error: 'invalid-app', errors: [{ code: 'SUI-USES-NEEDS', part: { kind: 'logic', name: 'pricing' } }] });
        expect(missing.body).toMatchObject({ error: 'not-found', missing: [{ kind: 'themes', name: 'shop-theme' }] });
        expect(bound.body).toMatchObject({ revision: 2 });
        expect((await appBody('shop'))['uses']).toEqual({ themes: ['store'], data: { items: { dataset: 'catalog' } }, logic: { pricing: { params: { taxRate: 0.2 } } } });
    });

    it('should refuse a start that names no screen, a stale revision, a missing app and an empty change', async () => {
        // Act
        const start = await call(harness.client, 'ui_app_configure', { name: 'shop', expectedRevision: 1, start: 'cart' });
        const stale = await call(harness.client, 'ui_app_configure', { name: 'shop', expectedRevision: 3, title: 'X' });
        const missing = await call(harness.client, 'ui_app_configure', { name: 'shpo', expectedRevision: 1, title: 'X' });
        const empty = await call(harness.client, 'ui_app_configure', { name: 'shop', expectedRevision: 1 });

        // Assert
        expect(start.body['error']).toBe('invalid-app');
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['shop'] });
        expect(empty.body['error']).toBe('invalid-argument');
        expect((await appBody('shop'))['title']).toBe('Corner shop');
    });
});

describe('ui_screen_create', () => {
    beforeEach(createShop);

    it('should add a screen with params that a later navigate can target, raising the app revision', async () => {
        // Act
        const product = await call(harness.client, 'ui_screen_create', {
            app: 'shop',
            name: 'product',
            expectedRevision: 1,
            title: 'Product',
            params: { id: { type: 'string', required: true } },
            root: { component: 'panel' }
        });
        const list = await call(harness.client, 'ui_screen_create', {
            app: 'shop',
            name: 'list',
            expectedRevision: 2,
            root: { component: 'button', _title: 'Lamp', on: { press: { command: 'navigate', target: 'product', value: { id: 'p1' } } } }
        });
        const screens = await call(harness.client, 'ui_list', { kind: 'screens', app: 'shop' });
        const validated = await call(harness.client, 'ui_validate', { app: 'shop' });

        // Assert
        expect(product.body).toEqual({ app: 'shop', name: 'product', revision: 2, slots: [], warnings: [] });
        expect(list.body).toMatchObject({ revision: 3 });
        expect(screens.body).toMatchObject({ revision: 3, items: [{ name: 'home', start: true }, { name: 'product', title: 'Product' }, { name: 'list' }] });
        expect(validated.body).toMatchObject({ valid: true, errors: [] });
    });

    it('should refuse a navigate to a screen the app does not have', async () => {
        // Act
        const result = await call(harness.client, 'ui_screen_create', {
            app: 'shop',
            name: 'list',
            expectedRevision: 1,
            root: { component: 'button', on: { press: { command: 'navigate', target: 'cart' } } }
        });

        // Assert
        expect(result.body['error']).toBe('invalid-app');
        expect((result.body['errors'] as { code: string }[]).map((error) => error.code)).toContain('SUI-ROUTE-SCREEN');
    });

    it('should refuse a duplicate name, a stale revision, a missing app and a pattern', async () => {
        // Act
        const duplicate = await call(harness.client, 'ui_screen_create', { app: 'shop', name: 'home', expectedRevision: 1, root: { component: 'panel' } });
        const stale = await call(harness.client, 'ui_screen_create', { app: 'shop', name: 'about', expectedRevision: 2, root: { component: 'panel' } });
        const missing = await call(harness.client, 'ui_screen_create', { app: 'shpo', name: 'about', expectedRevision: 1, root: { component: 'panel' } });
        const pattern = await call(harness.client, 'ui_screen_create', { app: 'shop', name: 'checkout', expectedRevision: 1, pattern: 'checkout' });
        const both = await call(harness.client, 'ui_screen_create', { app: 'shop', name: 'about', expectedRevision: 1, pattern: 'checkout', root: { component: 'panel' } });

        // Assert
        expect(duplicate.body['error']).toBe('duplicate-name');
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['shop'] });
        expect(pattern.body).toMatchObject({ error: 'invalid-argument', argument: 'pattern' });
        expect(pattern.body['message']).toContain('No such pattern');
        expect(both.body).toMatchObject({ error: 'invalid-argument' });
        expect((await appBody('shop'))['screens']).toEqual({ home: { title: 'Home', root: HOME_ROOT } });
    });
});
