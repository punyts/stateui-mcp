import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER_ID } from '../src/config/createServices.js';
import { PartFolders } from '../src/infrastructure/storage/PartFolders.js';
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
const CATALOG = deepFreeze({ model: 'product', records: { p1: { name: 'Lamp', price: 30 }, p2: { name: 'Chair', price: 90 } } }) as unknown as UiPartBodies['data'];
const SHOP = deepFreeze({
    title: 'Corner shop',
    uses: { themes: ['store'], data: { products: { dataset: 'catalog' } } },
    start: 'home',
    app: { component: 'app', _title: 'Corner shop', toasts: { component: 'toastRegion', messages: { saved: { _text: 'Saved' } } } },
    screens: {
        home: { title: 'Home', root: { component: 'panel', children: { intro: { component: 'text', _text: 'Welcome' } } } },
        about: { title: 'About us', root: { component: 'text', _text: 'About' } }
    }
}) as unknown as UiPartBodies['apps'];

let data: TempData;
let harness: InMemoryHarness;

async function write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], expectedRevision?: number): Promise<void> {
    const result = await harness.services.useCases.writePart!.execute({ kind, name, body, ...(expectedRevision !== undefined && { expectedRevision }) });
    if (result.kind !== 'written') throw new Error(`${kind} ${name}: ${JSON.stringify(result)}`);
}

async function seed(): Promise<void> {
    await write('themes', 'store', STORE);
    await write('models', 'product', PRODUCT);
    await write('data', 'catalog', CATALOG);
    await write('apps', 'shop', SHOP);
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    await seed();
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_list', () => {
    it('should list the parts of a kind with revisions, and an app with its title and uses', async () => {
        // Act
        const apps = await call(harness.client, 'ui_list', { kind: 'apps' });
        const models = await call(harness.client, 'ui_list', { kind: 'models' });

        // Assert
        expect(apps.isError).toBe(false);
        expect(apps.body).toMatchObject({ kind: 'apps', count: 1, items: [{ name: 'shop', title: 'Corner shop', revision: 1, uses: SHOP.uses }] });
        expect(models.body).toMatchObject({ kind: 'models', count: 1, items: [{ name: 'product', revision: 1 }] });
        expect((models.body['items'] as Record<string, unknown>[])[0]).not.toHaveProperty('uses');
    });

    it('should keep only the items with every query word in the name or title', async () => {
        // Act
        const corner = await call(harness.client, 'ui_list', { kind: 'apps', query: 'CORNER shop' });
        const none = await call(harness.client, 'ui_list', { kind: 'apps', query: 'corner bakery' });
        const screens = await call(harness.client, 'ui_list', { kind: 'screens', app: 'shop', query: 'us' });

        // Assert
        expect(corner.body['count']).toBe(1);
        expect(none.body).toMatchObject({ count: 0, items: [] });
        expect(screens.body).toMatchObject({ kind: 'screens', app: 'shop', revision: 1, items: [{ name: 'about', title: 'About us' }] });
    });

    it('should list the screens of an app and mark the start screen', async () => {
        // Act
        const result = await call(harness.client, 'ui_list', { kind: 'screens', app: 'shop' });

        // Assert
        expect(result.body).toEqual({
            kind: 'screens',
            app: 'shop',
            revision: 1,
            count: 2,
            items: [
                { name: 'home', title: 'Home', start: true },
                { name: 'about', title: 'About us' }
            ]
        });
    });

    it('should fail for an unknown kind with the list of kinds, for screens without app, and for a missing app', async () => {
        // Act
        const badKind = await call(harness.client, 'ui_list', { kind: 'pages' });
        const noApp = await call(harness.client, 'ui_list', { kind: 'screens' });
        const missing = await call(harness.client, 'ui_list', { kind: 'screens', app: 'shoppe' });

        // Assert
        expect(badKind.body).toMatchObject({ error: 'invalid-argument', argument: 'kind' });
        expect(badKind.body['message']).toBe('kind must be one of: apps, themes, logic, models, data, components, patterns, screens');
        expect(noApp.body).toMatchObject({ error: 'invalid-argument', argument: 'app' });
        expect(missing.body).toMatchObject({ error: 'not-found' });
    });
});

describe('ui_get', () => {
    it('should read a part with its id and revision, at a path and to a depth', async () => {
        // Act
        const whole = await call(harness.client, 'ui_get', { kind: 'data', name: 'catalog' });
        const record = await call(harness.client, 'ui_get', { kind: 'data', name: 'catalog', path: '$.records.p2' });
        const shallow = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop', path: 'screens.home.root', depth: 0 });

        // Assert
        expect(whole.body).toMatchObject({ kind: 'data', name: 'catalog', revision: 1, path: '', value: CATALOG, resolved: false });
        expect(whole.body['id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(record.body['value']).toEqual({ name: 'Chair', price: 90 });
        expect(shallow.body['value']).toEqual({ component: 'panel', children: { intro: { component: 'text', childCount: 0 } } });
    });

    it('should read a screen with its app\'s revision', async () => {
        // Act
        const result = await call(harness.client, 'ui_get', { kind: 'screens', app: 'shop', name: 'about' });

        // Assert
        expect(result.body).toMatchObject({ kind: 'screens', app: 'shop', name: 'about', revision: 1, value: SHOP.screens['about'] });
    });

    it('should read the assembled app with resolved, and refuse resolved on another kind', async () => {
        // Act
        const assembled = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop', resolved: true });
        const theme = await call(harness.client, 'ui_get', { kind: 'themes', name: 'store', resolved: true });

        // Assert
        const value = assembled.body['value'] as Record<string, unknown>;
        expect(assembled.body['resolved']).toBe(true);
        expect(assembled.body['note']).toContain('read only');
        expect(value['theme']).toEqual({ tokens: STORE.tokens });
        expect(value['data']).toEqual({ products: CATALOG.records });
        expect(theme.body).toMatchObject({ error: 'invalid-argument', argument: 'resolved' });
    });

    it('should name the nearest names when the part is not found, and where a path stops', async () => {
        // Act
        const missing = await call(harness.client, 'ui_get', { kind: 'themes', name: 'stor' });
        const missingScreen = await call(harness.client, 'ui_get', { kind: 'screens', app: 'shop', name: 'abut' });
        const missingPath = await call(harness.client, 'ui_get', { kind: 'data', name: 'catalog', path: 'records.p9.name' });
        const badKind = await call(harness.client, 'ui_get', { kind: 'widgets', name: 'store' });

        // Assert
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['store'] });
        expect(missingScreen.body).toMatchObject({ error: 'not-found', app: 'shop', nearest: ['about'] });
        expect(missingScreen.body['message']).toContain('The app "shop" has no screen "abut"');
        expect(missingPath.body).toMatchObject({ error: 'missing-path', missingAt: 'records.p9' });
        expect(badKind.body).toMatchObject({ error: 'invalid-argument', argument: 'kind' });
    });
});

describe('ui_delete', () => {
    it('should refuse a part that is used, naming the users, and delete it once nothing uses it', async () => {
        // Act
        const used = await call(harness.client, 'ui_delete', { kind: 'themes', name: 'store', expectedRevision: 1 });
        const app = await call(harness.client, 'ui_delete', { kind: 'apps', name: 'shop', expectedRevision: 1 });
        const free = await call(harness.client, 'ui_delete', { kind: 'themes', name: 'store', expectedRevision: 1 });
        const list = await call(harness.client, 'ui_list', { kind: 'themes' });

        // Assert
        expect(used.body).toMatchObject({ error: 'in-use', users: [{ kind: 'apps', name: 'shop' }] });
        expect(used.body['message']).toContain('nothing was deleted');
        expect(app.body).toEqual({ kind: 'apps', name: 'shop', revision: 1 });
        expect(free.isError).toBe(false);
        expect(list.body['count']).toBe(0);
    });

    it('should delete the instance of an app with the app', async () => {
        // Arrange
        const id = (await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop', path: 'start' })).body['id'] as string;
        const instance = new PartFolders(data.dir).instanceFile(LOCAL_OWNER_ID, id);
        await mkdir(dirname(instance), { recursive: true });
        await writeFile(instance, JSON.stringify({ route: { screen: 'about' } }));

        // Act
        const deleted = await call(harness.client, 'ui_delete', { kind: 'apps', name: 'shop', expectedRevision: 1 });

        // Assert
        expect(deleted.isError).toBe(false);
        await expect(stat(instance)).rejects.toThrow();
    });

    it('should remove the side folder of an app, its errors and files, and its stored instance, and keep them away', async () => {
        // Arrange: a running instance whose state was changed, an uploaded file and a reported runtime error
        const form = deepFreeze({
            start: 'home',
            app: { component: 'app' },
            screens: { home: { root: { component: 'panel', children: { search: { component: 'textField', _label: 'Search' } } } } }
        }) as unknown as UiPartBodies['apps'];
        await write('apps', 'form', form);
        const id = (await call(harness.client, 'ui_get', { kind: 'apps', name: 'form', path: 'start' })).body['id'] as string;
        const folders = new PartFolders(data.dir);
        const upload = await harness.services.useCases.uploadFile.execute(id, {
            name: 'notes.txt',
            content: (async function* () {
                yield Buffer.from('hello');
            })()
        });
        await harness.services.useCases.recordPreviewErrors.execute(id, [{ code: 'SUI-RUN-BINDING', message: 'boom' }]);
        const typed = await call(harness.client, 'ui_state_set', { app: 'form', path: '$.screens.home.children.search.value', value: 'lamp' });
        const side = folders.dir(id);
        const instance = folders.instanceFile(LOCAL_OWNER_ID, id);
        expect((await stat(side)).isDirectory()).toBe(true);

        // Act
        const deleted = await call(harness.client, 'ui_delete', { kind: 'apps', name: 'form', expectedRevision: 1 });
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Assert
        expect(upload.kind).toBe('uploaded');
        expect(typed.isError).toBe(false);
        expect(deleted.isError).toBe(false);
        await expect(stat(side)).rejects.toThrow();
        await expect(stat(instance)).rejects.toThrow();
        expect(await harness.services.useCases.recordPreviewErrors.execute(id, [{ code: 'X', message: 'm' }])).toMatchObject({ kind: 'not-found' });
        await expect(stat(side)).rejects.toThrow();
    });

    it('should refuse a stale revision and a missing part, and change nothing', async () => {
        // Act
        const stale = await call(harness.client, 'ui_delete', { kind: 'apps', name: 'shop', expectedRevision: 4 });
        const missing = await call(harness.client, 'ui_delete', { kind: 'apps', name: 'shops', expectedRevision: 1 });
        const badKind = await call(harness.client, 'ui_delete', { kind: 'pages', name: 'shop', expectedRevision: 1 });
        const list = await call(harness.client, 'ui_list', { kind: 'apps' });

        // Assert
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['shop'] });
        expect(badKind.body).toMatchObject({ error: 'invalid-argument', argument: 'kind' });
        expect(list.body['count']).toBe(1);
    });

    it('should delete a screen with the app\'s revision and refuse the start screen', async () => {
        // Act
        const start = await call(harness.client, 'ui_delete', { kind: 'screens', app: 'shop', name: 'home', expectedRevision: 1 });
        const about = await call(harness.client, 'ui_delete', { kind: 'screens', app: 'shop', name: 'about', expectedRevision: 1 });
        const screens = await call(harness.client, 'ui_list', { kind: 'screens', app: 'shop' });

        // Assert
        expect(start.body).toMatchObject({ error: 'in-use', users: [{ kind: 'apps', name: 'shop' }] });
        expect(start.body['message']).toContain('is the start screen of the app "shop"');
        expect(about.body).toEqual({ kind: 'screens', name: 'about', app: 'shop', revision: 2 });
        expect(screens.body).toMatchObject({ revision: 2, items: [{ name: 'home' }] });
    });
});

describe('ui_rename', () => {
    it('should rename a part and rewrite every part that names it, with their new revisions', async () => {
        // Act
        const result = await call(harness.client, 'ui_rename', { kind: 'data', name: 'catalog', to: 'products', expectedRevision: 1 });
        const app = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop', path: 'uses.data' });

        // Assert
        expect(result.body).toEqual({ kind: 'data', name: 'products', revision: 2, rewritten: [{ kind: 'apps', name: 'shop', revision: 2 }] });
        expect(app.body['value']).toEqual({ products: { dataset: 'products' } });
    });

    it('should rename a screen with the app\'s revision and move start with it', async () => {
        // Act
        const result = await call(harness.client, 'ui_rename', { kind: 'screens', app: 'shop', name: 'home', to: 'welcome', expectedRevision: 1 });
        const start = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop', path: 'start' });

        // Assert
        expect(result.body).toEqual({ kind: 'screens', name: 'welcome', app: 'shop', revision: 2, rewritten: [] });
        expect(start.body['value']).toBe('welcome');
    });

    it('should refuse a stale revision, a missing part, a taken or bad name and a bad kind, and change nothing', async () => {
        // Arrange
        await write('themes', 'night', STORE);

        // Act
        const stale = await call(harness.client, 'ui_rename', { kind: 'themes', name: 'store', to: 'shop-theme', expectedRevision: 2 });
        const missing = await call(harness.client, 'ui_rename', { kind: 'themes', name: 'day', to: 'dawn', expectedRevision: 1 });
        const taken = await call(harness.client, 'ui_rename', { kind: 'themes', name: 'store', to: 'night', expectedRevision: 1 });
        const bad = await call(harness.client, 'ui_rename', { kind: 'themes', name: 'store', to: 'Shop Theme', expectedRevision: 1 });
        const badKind = await call(harness.client, 'ui_rename', { kind: 'skins', name: 'store', to: 'x', expectedRevision: 1 });
        const themes = await call(harness.client, 'ui_list', { kind: 'themes' });

        // Assert
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(missing.body).toMatchObject({ error: 'not-found' });
        expect(taken.body).toMatchObject({ error: 'duplicate-name' });
        expect(bad.body).toMatchObject({ error: 'invalid-name', argument: 'to' });
        expect(badKind.body).toMatchObject({ error: 'invalid-argument', argument: 'kind' });
        expect((themes.body['items'] as { name: string; revision: number }[]).map((item) => [item.name, item.revision])).toEqual([
            ['night', 1],
            ['store', 1]
        ]);
    });
});

describe('ui_validate with app', () => {
    it('should validate an app of parts, naming the part that holds each error', async () => {
        // Arrange
        await write('logic', 'pricing', { needs: { products: { model: 'product' } }, params: {} } as unknown as UiPartBodies['logic']);
        await write('apps', 'shop', { ...SHOP, uses: { ...SHOP.uses, logic: { pricing: {} } } } as unknown as UiPartBodies['apps'], 1);
        const valid = await call(harness.client, 'ui_validate', { app: 'shop' });
        await write('logic', 'pricing', { needs: { products: { model: 'product' }, orders: { model: 'product' } }, params: {} } as unknown as UiPartBodies['logic'], 1);

        // Act
        const broken = await call(harness.client, 'ui_validate', { app: 'shop' });
        const missing = await call(harness.client, 'ui_validate', { app: 'shops' });
        const both = await call(harness.client, 'ui_validate', { app: 'shop', appId: '00000000-0000-4000-8000-000000000009' });
        const neither = await call(harness.client, 'ui_validate', {});

        // Assert
        expect(valid.body).toMatchObject({ app: 'shop', revision: 2, valid: true, errors: [] });
        expect(valid.body['uses']).toEqual(expect.arrayContaining([{ kind: 'themes', name: 'store' }, { kind: 'data', name: 'catalog' }, { kind: 'logic', name: 'pricing' }]));
        expect(broken.body).toMatchObject({ app: 'shop', revision: 2, valid: false });
        expect(broken.body['errors']).toEqual([expect.objectContaining({ code: 'SUI-USES-NEEDS', part: { kind: 'logic', name: 'pricing' } })]);
        expect(missing.body).toMatchObject({ error: 'not-found', app: 'shops' });
        expect(both.body).toMatchObject({ error: 'invalid-argument' });
        expect(neither.body).toMatchObject({ error: 'invalid-argument' });
    });
});
