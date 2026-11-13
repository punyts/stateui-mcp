import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

const CHAT = 'M4 5h16v11H9l-5 4z';

let data: TempData;
let harness: InMemoryHarness;

async function appBody(): Promise<Record<string, unknown>> {
    const read = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' });
    return read.body['value'] as Record<string, unknown>;
}

async function icons(operations: readonly object[], expectedRevision = 1) {
    return call(harness.client, 'ui_icons_write', { app: 'shop', expectedRevision, operations });
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    const created = await call(harness.client, 'ui_app_create', { name: 'shop', title: 'Shop' });
    if (created.isError) throw new Error(JSON.stringify(created.body));
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_icons_write', () => {
    it("should write the app's own icons and return their names", async () => {
        // Act
        const result = await icons([
            { op: 'set', name: 'chat', outline: [CHAT] },
            { op: 'set', name: 'prefs', outline: ['M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0', { d: 'M12 4a8 8 0 0 0 0 16z', fill: true }] }
        ]);
        const body = await appBody();

        // Assert
        expect(result.body).toMatchObject({ app: 'shop', revision: 2, icons: ['chat', 'prefs'], warnings: [] });
        expect(body['icons']).toEqual({
            chat: { outline: [CHAT] },
            prefs: { outline: ['M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0', { d: 'M12 4a8 8 0 0 0 0 16z', fill: true }] }
        });
    });

    it('should let a node name an app icon, which the icon set does not have', async () => {
        // Arrange
        await icons([{ op: 'set', name: 'chat-bubble-own', outline: [CHAT] }]);

        // Act
        const placed = await call(harness.client, 'ui_nodes_write', {
            app: 'shop',
            screen: 'home',
            expectedRevision: 2,
            operations: [{ op: 'add', path: 'root', key: 'mark', value: { component: 'icon', name: 'chat-bubble-own' } }]
        });
        const unknown = await call(harness.client, 'ui_nodes_write', {
            app: 'shop',
            screen: 'home',
            expectedRevision: 3,
            operations: [{ op: 'add', path: 'root', key: 'other', value: { component: 'icon', name: 'not-an-icon-anywhere' } }]
        });

        // Assert
        expect(placed.isError).toBe(false);
        expect(unknown.body).toMatchObject({ error: 'invalid-app' });
        expect(JSON.stringify(unknown.body)).toContain('not-an-icon-anywhere');
    });

    it('should refuse markup, url() and other attributes, and write nothing', async () => {
        // Act
        const markup = await icons([{ op: 'set', name: 'bad', outline: ['<path d="M0 0"/>'] }]);
        const link = await icons([{ op: 'set', name: 'bad', outline: ['url(#x)'] }]);
        const styled = await icons([{ op: 'set', name: 'bad', outline: [{ d: CHAT, style: 'fill:red' }] }]);
        const body = await appBody();

        // Assert
        for (const result of [markup, link, styled]) expect(result.body).toMatchObject({ error: 'invalid-app' });
        expect(JSON.stringify(markup.body)).toContain('$.icons.bad.outline.0');
        expect(body).not.toHaveProperty('icons');
    });

    it('should remove an icon, drop icons once none is left, and refuse an unknown one', async () => {
        // Arrange
        await icons([{ op: 'set', name: 'chat', outline: [CHAT] }]);

        // Act
        const unknown = await icons([{ op: 'remove', name: 'caht' }], 2);
        const removed = await icons([{ op: 'remove', name: 'chat' }], 2);
        const body = await appBody();

        // Assert
        expect(unknown.body).toMatchObject({ error: 'invalid-operation', index: 0 });
        expect(JSON.stringify(unknown.body)).toContain('chat');
        expect(removed.body).toMatchObject({ revision: 3, icons: [] });
        expect(body).not.toHaveProperty('icons');
    });

    it('should refuse a set without outline, a remove with paths and a stale revision', async () => {
        // Act
        const noOutline = await icons([{ op: 'set', name: 'chat' }]);
        const removeWithPaths = await icons([{ op: 'remove', name: 'chat', outline: [CHAT] }]);
        const stale = await icons([{ op: 'set', name: 'chat', outline: [CHAT] }], 7);

        // Assert
        expect(noOutline.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].outline' });
        expect(removeWithPaths.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].outline' });
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
    });
});

describe('ui_icons_list with app', () => {
    it("should list the app's own icons first, with source app, and leave out a set icon they shadow", async () => {
        // Arrange
        await icons([
            { op: 'set', name: 'send', outline: ['M12 19V5M5 12l7-7 7 7'] },
            { op: 'set', name: 'chat', outline: [CHAT], filled: [CHAT] }
        ]);

        // Act
        const result = await call(harness.client, 'ui_icons_list', { app: 'shop', query: 'send' });
        const own = await call(harness.client, 'ui_icons_list', { app: 'shop', category: 'app' });

        // Assert
        const listed = result.body['icons'] as { name: string; source: string; category: string }[];
        expect(listed[0]).toMatchObject({ name: 'send', source: 'app', category: 'app' });
        expect(listed.filter((icon) => icon.name === 'send')).toHaveLength(1);
        expect(listed.slice(1).every((icon) => icon.source === 'set')).toBe(true);
        expect(own.body).toMatchObject({ total: 2, more: 0 });
        expect(own.body['icons']).toEqual([
            { name: 'send', category: 'app', tags: [], hasFilled: false, source: 'app' },
            { name: 'chat', category: 'app', tags: [], hasFilled: true, source: 'app' }
        ]);
    });

    it('should name the nearest apps for an unknown app', async () => {
        // Act
        const result = await call(harness.client, 'ui_icons_list', { app: 'shpo' });

        // Assert
        expect(result.body).toMatchObject({ error: 'not-found', argument: 'app', nearest: ['shop'] });
    });
});

describe('ui_app_create with icons', () => {
    it('should create an app whose home names its own icons from the start', async () => {
        // Act
        const created = await call(harness.client, 'ui_app_create', {
            name: 'kiosk',
            icons: { chat: { outline: [CHAT] } },
            home: { component: 'panel', children: { mark: { component: 'icon', name: 'chat' } } }
        });
        const read = await call(harness.client, 'ui_get', { kind: 'apps', name: 'kiosk' });

        // Assert
        expect(created.isError).toBe(false);
        expect((read.body['value'] as Record<string, unknown>)['icons']).toEqual({ chat: { outline: [CHAT] } });
    });
});
