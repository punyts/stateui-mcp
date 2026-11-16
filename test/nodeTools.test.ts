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

const TOASTS = deepFreeze({ component: 'toastRegion', messages: { saved: { tone: 'success', _title: 'Saved' } } });
const HOME = deepFreeze({
    component: 'panel',
    children: { title: { component: 'text', _text: 'Welcome' }, intro: { component: 'text', _text: 'Lamps and more' }, box: { component: 'panel' } }
});

let data: TempData;
let harness: InMemoryHarness;

async function appBody(): Promise<Record<string, unknown>> {
    const read = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' });
    return read.body['value'] as Record<string, unknown>;
}

async function homeRoot(): Promise<Record<string, unknown>> {
    return ((await appBody())['screens'] as Record<string, { root: Record<string, unknown> }>)['home']!.root;
}

function childKeys(node: Record<string, unknown>): string[] {
    return Object.keys(node['children'] as object);
}

async function nodes(operations: readonly object[], screen = 'home', expectedRevision = 2) {
    return call(harness.client, 'ui_nodes_write', { app: 'shop', screen, expectedRevision, operations });
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    const created = await call(harness.client, 'ui_app_create', { name: 'shop', title: 'Shop' });
    if (created.isError) throw new Error(JSON.stringify(created.body));
    const home = await call(harness.client, 'ui_nodes_write', { app: 'shop', screen: 'home', expectedRevision: 1, operations: [{ op: 'set', path: 'root', value: HOME }] });
    if (home.isError) throw new Error(JSON.stringify(home.body));
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_nodes_write', () => {
    it('should add nodes under generated and given keys and return their paths', async () => {
        // Act
        const result = await nodes([
            { op: 'add', path: 'root', value: { component: 'button', _title: 'Buy' } },
            { op: 'add', path: 'root', value: { component: 'button', _title: 'Back' } },
            { op: 'add', path: '$.screens.home', key: 'lead', before: 'title', value: { component: 'text', _text: 'New' } }
        ]);
        const root = await homeRoot();

        // Assert
        expect(result.body).toEqual({
            app: 'shop',
            screen: 'home',
            revision: 3,
            warnings: [],
            added: [
                { index: 0, path: 'root.children.button' },
                { index: 1, path: 'root.children.button2' },
                { index: 2, path: 'root.children.lead' }
            ]
        });
        expect(childKeys(root)).toEqual(['lead', 'title', 'intro', 'box', 'button', 'button2']);
    });

    it('should set, merge, remove and move in order as one write', async () => {
        // Act
        const result = await nodes([
            { op: 'set', path: 'root.children.title._text', value: 'Hello' },
            { op: 'merge', path: 'root.children.box', value: { children: { note: { component: 'text', _text: 'Note' } } } },
            { op: 'remove', path: 'root.children.intro' },
            { op: 'move', path: '$.screens.home.children.title', to: 'root.children.box.children', before: 'note' }
        ]);
        const root = await homeRoot();

        // Assert
        expect(result.body).toMatchObject({ revision: 3, added: [] });
        expect(childKeys(root)).toEqual(['box']);
        expect((root['children'] as Record<string, Record<string, unknown>>)['box']).toEqual({
            component: 'panel',
            children: { title: { component: 'text', _text: 'Hello' }, note: { component: 'text', _text: 'Note' } }
        });
    });

    it('should refuse a stale revision, a missing parent and an integer-like key and write nothing', async () => {
        // Act
        const stale = await nodes([{ op: 'remove', path: 'root.children.intro' }], 'home', 1);
        const parent = await nodes([{ op: 'set', path: 'root.children.missing._text', value: 'x' }]);
        const integer = await nodes([{ op: 'add', path: 'root', key: '42', value: { component: 'text' } }]);
        const integerMerge = await nodes([{ op: 'merge', path: 'root.children', value: { 7: { component: 'text' } } }]);

        // Assert
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 2 });
        expect(parent.body).toMatchObject({ error: 'invalid-operation', index: 0 });
        expect(integer.isError).toBe(true);
        expect(integerMerge.isError).toBe(true);
        expect(await homeRoot()).toEqual(HOME);
    });

    it('should refuse a path of another tree, a missing screen and a missing app', async () => {
        // Act
        const other = await nodes([{ op: 'remove', path: '$.app._title' }]);
        const screen = await nodes([{ op: 'remove', path: 'root.children.intro' }], 'hom');
        const app = await call(harness.client, 'ui_nodes_write', { app: 'shpo', screen: 'home', expectedRevision: 2, operations: [{ op: 'remove', path: 'root' }] });
        const key = await nodes([{ op: 'set', path: 'root.children.title._text', key: 'x', value: 'y' }]);

        // Assert
        expect(other.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].path' });
        expect(screen.body).toMatchObject({ error: 'not-found', argument: 'screen', nearest: ['home'] });
        expect(app.body).toMatchObject({ error: 'not-found', argument: 'app', nearest: ['shop'] });
        expect(key.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].key' });
    });

    it('should write the app node with screen "app" and refuse an app node of another component', async () => {
        // Act
        const toasts = await nodes([{ op: 'set', path: '$.app.toasts', value: TOASTS }], 'app');
        const other = await nodes([{ op: 'set', path: 'root.component', value: 'panel' }], 'app', 3);
        const body = await appBody();

        // Assert
        expect(toasts.body).toMatchObject({ screen: 'app', revision: 3 });
        expect(other.body['error']).toBe('invalid-app');
        expect(body['app']).toEqual({ _title: 'Shop', component: 'app', toasts: TOASTS });
    });
});

describe('ui_locale_write', () => {
    async function locale(operations: readonly object[], expectedRevision = 2, screen = 'home', language = 'de') {
        return call(harness.client, 'ui_locale_write', { app: 'shop', screen, language, expectedRevision, operations });
    }

    it('should write a screen overlay and warn about each untranslated path', async () => {
        // Act
        const result = await locale([{ op: 'set', path: 'root.children.title._text', value: 'Willkommen' }]);
        const body = await appBody();

        // Assert
        expect(result.body).toMatchObject({ app: 'shop', screen: 'home', language: 'de', revision: 3 });
        const warnings = result.body['warnings'] as { code: string; statePath?: string }[];
        expect(warnings.map((warning) => warning.code)).toContain('SUI-LOCALE-MISSING');
        expect(JSON.stringify(warnings)).toContain('intro');
        expect(JSON.stringify(warnings)).not.toContain('title');
        expect((body['screens'] as Record<string, Record<string, unknown>>)['home']!['locales']).toEqual({ de: { children: { title: { _text: 'Willkommen' } } } });
    });

    it('should leave no warning once every path is translated, and prune a removed overlay', async () => {
        // Act
        const full = await locale([
            { op: 'set', path: 'root.children.title._text', value: 'Willkommen' },
            { op: 'set', path: '$.screens.home.children.intro._text', value: 'Lampen und mehr' }
        ]);
        const removed = await locale(
            [
                { op: 'remove', path: 'root.children.title._text' },
                { op: 'remove', path: 'root.children.intro._text' }
            ],
            3
        );
        const body = await appBody();

        // Assert
        expect(full.body).toMatchObject({ revision: 3, warnings: [] });
        expect(removed.body).toMatchObject({ revision: 4 });
        expect((body['screens'] as Record<string, Record<string, unknown>>)['home']).not.toHaveProperty('locales');
    });

    it('should write the app node overlay into the app locales', async () => {
        // Act
        const result = await locale([{ op: 'set', path: '$.app._title', value: 'Laden' }], 2, 'app');
        const body = await appBody();

        // Assert
        expect(result.body).toMatchObject({ screen: 'app', revision: 3 });
        expect(body['locales']).toEqual({ de: { _title: 'Laden' } });
    });

    it('should refuse a bad language, a path off the tree, a non-content path and a stale revision', async () => {
        // Act
        const language = await locale([{ op: 'set', path: 'root.children.title._text', value: 'x' }], 2, 'home', 'German');
        const offTree = await locale([{ op: 'set', path: '$.app._title', value: 'x' }]);
        const rootOnly = await locale([{ op: 'set', path: 'root', value: {} }]);
        const notContent = await locale([{ op: 'set', path: 'root.children.nope._text', value: 'x' }]);
        const stale = await locale([{ op: 'set', path: 'root.children.title._text', value: 'x' }], 1);

        // Assert
        expect(language.body).toMatchObject({ error: 'invalid-argument', argument: 'language' });
        expect(offTree.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].path' });
        expect(rootOnly.body).toMatchObject({ error: 'invalid-operation', index: 0 });
        expect(notContent.isError).toBe(true);
        expect(stale.body).toMatchObject({ error: 'conflict' });
        expect(await appBody()).not.toHaveProperty('screens.home.locales');
    });
});
