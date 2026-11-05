import { describe, expect, it, vi } from 'vitest';
import { IndexedUiPartRepository } from '../../application/IndexedUiPartRepository.js';
import type { ComponentCatalog } from '../../application/ports/ComponentCatalog.js';
import type { InstanceShape } from '../../application/ports/InstanceStates.js';
import type { GetUiApp } from '../../application/use-cases/GetUiApp.js';
import type { UiPart, UiPartBodies } from '../../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../../testing/InMemoryUiPartRepository.js';
import { InstanceViews } from './InstanceViews.js';
import { LiveViews } from './LiveViews.js';
import { PreviewHub } from './PreviewHub.js';
import type { ViewConnection, ViewMessage } from './PreviewHub.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const OWNER = '00000000-0000-4000-8000-0000000000AA';
const STORE = deepFreeze({ tokens: { color: { accent: { base: '#204080' } } } }) as unknown as UiPartBodies['themes'];
const NIGHT = deepFreeze({ tokens: { color: { accent: { base: '#000000' } } } }) as unknown as UiPartBodies['themes'];

function app(theme: string, text: string): UiPartBodies['apps'] {
    return deepFreeze({ uses: { themes: [theme] }, shell: { component: 'page', children: { title: { component: 'text', _text: text, icon: 'star' } } } }) as unknown as UiPartBodies['apps'];
}

/** The assembled document of the fake instance states: the app body with the bodies of its themes, as the real one would carry them */
async function shapeOf(parts: IndexedUiPartRepository, part: UiPart<'apps'>): Promise<InstanceShape> {
    const themes = (part.body as unknown as { uses: { themes: string[] } }).uses.themes;
    const bodies = await Promise.all(themes.map((name) => parts.findByName('themes', name)));
    return { document: { app: (part.body as unknown as { shell: never }).shell, themes: bodies.map((theme) => theme?.body ?? null) } as never, bindings: {} };
}

const CATALOG = Object.freeze({ get: () => undefined, iconPaths: (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, `M0 0 ${name}`])) }) as unknown as ComponentCatalog;
const NO_OLD_APP = Object.freeze({ execute: async (appId: string) => ({ kind: 'not-found', appId }) }) as unknown as GetUiApp;

async function setUp() {
    const parts = new IndexedUiPartRepository(new InMemoryUiPartRepository());
    for (const [kind, name, body] of [
        ['themes', 'store', STORE],
        ['themes', 'night', NIGHT],
        ['apps', 'shop', app('store', 'Shop')],
        ['apps', 'kiosk', app('night', 'Kiosk')]
    ] as const) {
        await parts.create({ kind, name, body } as never);
    }
    const states = { shape: vi.fn((part: UiPart<'apps'>) => shapeOf(parts, part)), authority: vi.fn() };
    const views = new InstanceViews(parts, parts, states as never, CATALOG, ['home'], OWNER);
    const hub = new PreviewHub();
    const live = new LiveViews(NO_OLD_APP, hub, { closePage: async () => undefined }, views);
    const shop = (await parts.findByName('apps', 'shop')) as UiPart<'apps'>;
    const kiosk = (await parts.findByName('apps', 'kiosk')) as UiPart<'apps'>;
    return { parts, views, hub, live, shop, kiosk };
}

function view(hub: PreviewHub, appId: string): ViewMessage[] {
    const received: ViewMessage[] = [];
    const connection: ViewConnection = { id: crypto.randomUUID(), kind: 'browser', send: (message) => received.push(message) };
    hub.attach(appId, connection);
    return received;
}

describe('LiveViews of owner apps', () => {
    it('should attach a view of an app part with the assembled document, its icons and revision 1', async () => {
        // Arrange
        const { live, views, shop } = await setUp();

        // Act
        const message = await live.attachMessage(shop.id);

        // Assert
        expect(message).toMatchObject({ type: 'app', reason: 'attach', revision: 1, icons: { star: 'M0 0 star' } });
        expect(JSON.stringify(message)).toContain('#204080');
        expect(views.namespace(shop)).toBe(`instances.default.${OWNER.toLowerCase()}.${shop.id.toLowerCase()}`);
    });

    it('should leave an id that is neither an app document nor an app part unknown', async () => {
        // Arrange
        const { live } = await setUp();

        // Act
        const message = await live.attachMessage(crypto.randomUUID());

        // Assert
        expect(message).toBeUndefined();
    });

    it('should send a written theme to the views of the apps that use it only, with the next revision', async () => {
        // Arrange
        const { parts, live, hub, shop, kiosk } = await setUp();
        await live.attachMessage(shop.id);
        const shopView = view(hub, shop.id);
        const kioskView = view(hub, kiosk.id);
        parts.onChange((kind, name) => void live.partChanged(kind, name));
        const delivered = vi.spyOn(live, 'partChanged');

        // Act
        await parts.write('themes', 'store', NIGHT, 1);
        const count = await delivered.mock.results[0]?.value;

        // Assert
        expect(count).toBe(1);
        expect(kioskView).toEqual([]);
        expect(shopView).toEqual([expect.objectContaining({ type: 'app', reason: 'document', revision: 2 })]);
        expect(JSON.stringify(shopView[0])).toContain('#000000');
    });

    it('should keep the revision when the assembled document did not change, and send nothing to an app without views', async () => {
        // Arrange
        const { live, views, hub, shop, kiosk } = await setUp();
        await live.attachMessage(shop.id);
        const shopView = view(hub, shop.id);

        // Act
        const toShop = await live.partChanged('apps', 'shop');
        const toKiosk = await live.partChanged('themes', 'night');

        // Assert
        expect(toShop).toBe(1);
        expect(toKiosk).toBe(0);
        expect(shopView).toEqual([expect.objectContaining({ reason: 'document', revision: 1 })]);
        expect(views.revision(shop.id)).toBe(1);
        expect(views.revision(kiosk.id)).toBeUndefined();
    });
});
