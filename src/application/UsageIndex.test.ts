import { describe, expect, it } from 'vitest';
import type { PartKind } from '../domain/partName.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../testing/InMemoryUiPartRepository.js';
import { deleteRule } from './deleteRule.js';
import { IndexedUiPartRepository } from './IndexedUiPartRepository.js';
import { UsageIndex } from './UsageIndex.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const PRODUCT_MODEL = deepFreeze({ fields: { name: { type: 'string' } } }) as UiPartBodies['models'];
const LINE_MODEL = deepFreeze({ fields: { qty: { type: 'integer' } } }) as UiPartBodies['models'];
const STORE_THEME = deepFreeze({ tokens: { color: { brand: '#204080' } } }) as UiPartBodies['themes'];
const CATALOG = deepFreeze({ model: 'product', records: { p1: { name: 'Lamp' } } }) as UiPartBodies['data'];
const CART_MODULE = deepFreeze({ needs: { lines: { model: 'line' } }, params: {} }) as unknown as UiPartBodies['logic'];
const BADGE = deepFreeze({ tree: { component: 'text', text: 'New' }, exposes: [] }) as unknown as UiPartBodies['components'];
const CARD = deepFreeze({
    tree: { component: 'stack', children: { title: { component: 'text' }, badge: { component: 'badge' } } },
    exposes: []
}) as unknown as UiPartBodies['components'];

/** A shop: theme, catalog dataset, persona bag of lines, the cart module, a card in a screen; `home` is the start */
const SHOP = deepFreeze({
    uses: { themes: ['store'], data: { catalog: { dataset: 'catalog' }, bag: { model: 'line', scope: 'persona' } }, logic: { cart: {} } },
    start: 'home',
    shell: { component: 'stack', children: { body: { component: 'outlet' } } },
    screens: {
        home: { root: { component: 'stack', children: { first: { component: 'card' } } } },
        about: { root: { component: 'text', text: 'About' } }
    }
}) as unknown as UiPartBodies['apps'];

const PARTS: ReadonlyArray<readonly [PartKind, string, UiPartBodies[PartKind]]> = [
    ['models', 'product', PRODUCT_MODEL],
    ['models', 'line', LINE_MODEL],
    ['themes', 'store', STORE_THEME],
    ['data', 'catalog', CATALOG],
    ['logic', 'cart', CART_MODULE],
    ['components', 'badge', BADGE],
    ['components', 'card', CARD],
    ['apps', 'shop', SHOP]
];

function shopIndex(): UsageIndex {
    const index = new UsageIndex();
    for (const [kind, name, body] of PARTS) index.set(kind, name, body);
    return index;
}

describe('UsageIndex and deleteRule', () => {
    describe('one case per reference kind', () => {
        const CASES: ReadonlyArray<readonly [string, PartKind, string, string, string]> = [
            ['a theme in uses.themes', 'themes', 'store', 'apps/shop', 'The theme "store" is used by the app "shop": change or delete them first'],
            ['a dataset in uses.data', 'data', 'catalog', 'apps/shop', 'The dataset "catalog" is used by the app "shop": change or delete them first'],
            ['a module in uses.logic', 'logic', 'cart', 'apps/shop', 'The logic module "cart" is used by the app "shop": change or delete them first'],
            ['a model of a dataset', 'models', 'product', 'data/catalog', 'The model "product" is used by the dataset "catalog": change or delete them first'],
            ['a composed name in another component', 'components', 'badge', 'components/card', 'The component "badge" is used by the component "card": change or delete them first'],
            ['a composed name in an app node', 'components', 'card', 'apps/shop', 'The component "card" is used by the app "shop": change or delete them first']
        ];

        it.each(CASES)('should report %s', (_case, kind, name, user, reason) => {
            // Arrange
            const index = shopIndex();

            // Act
            const users = index.usedBy(kind, name);
            const ruling = deleteRule(index, { kind, name });

            // Assert
            expect(users.map((ref) => `${ref.kind}/${ref.name}`)).toEqual([user]);
            expect(ruling).toEqual({ kind: 'refused', reason, users });
        });

        it('should report a model of a module\'s needs and of a uses.data entry, naming both users', () => {
            // Arrange
            const index = shopIndex();

            // Act
            const users = index.usedBy('models', 'line');
            const ruling = deleteRule(index, { kind: 'models', name: 'line' });

            // Assert
            expect(users).toEqual([{ kind: 'apps', name: 'shop' }, { kind: 'logic', name: 'cart' }]);
            expect(ruling).toEqual({
                kind: 'refused',
                reason: 'The model "line" is used by the app "shop" and the logic module "cart": change or delete them first',
                users
            });
        });

        it('should report the start screen of an app and allow another screen', () => {
            // Arrange
            const index = shopIndex();

            // Act
            const users = index.usedBy('screens', 'home', 'shop');
            const start = deleteRule(index, { kind: 'screens', app: 'shop', name: 'home' });
            const other = deleteRule(index, { kind: 'screens', app: 'shop', name: 'about' });

            // Assert
            expect(users).toEqual([{ kind: 'apps', name: 'shop' }]);
            expect(start).toEqual({ kind: 'refused', reason: 'The screen "home" is the start screen of the app "shop": make another screen the start first', users });
            expect(other).toEqual({ kind: 'ok' });
        });
    });

    it('should allow deleting a part with no users', () => {
        // Arrange
        const index = shopIndex();

        // Act, Assert
        expect(index.usedBy('apps', 'shop')).toEqual([]);
        expect(deleteRule(index, { kind: 'apps', name: 'shop' })).toEqual({ kind: 'ok' });
    });

    it('should list what an app uses, without library components', () => {
        // Act
        const uses = shopIndex().uses('shop');

        // Assert
        expect(uses.map((ref) => `${ref.kind}/${ref.name}`)).toEqual(['themes/store', 'data/catalog', 'models/line', 'logic/cart', 'components/card']);
    });

    it('should find the apps that reach a part through other parts', () => {
        // Arrange
        const index = shopIndex();

        // Act, Assert
        expect(index.appsUsing('models', 'product')).toEqual(['shop']);
        expect(index.appsUsing('components', 'badge')).toEqual(['shop']);
        expect(index.appsUsing('apps', 'shop')).toEqual([]);
    });

    describe('IndexedUiPartRepository', () => {
        async function storedShop(): Promise<IndexedUiPartRepository> {
            const inner = new InMemoryUiPartRepository();
            for (const [kind, name, body] of PARTS) await inner.create({ kind, name, body });
            return new IndexedUiPartRepository(inner);
        }

        it('should build the index from the stored parts at the first call', async () => {
            // Arrange
            const parts = await storedShop();

            // Act
            const index = await parts.usage();

            // Assert
            expect(index.usedBy('themes', 'store')).toEqual([{ kind: 'apps', name: 'shop' }]);
            expect(index.usedBy('screens', 'home', 'shop')).toHaveLength(1);
        });

        it('should follow a write, a delete and a create', async () => {
            // Arrange
            const parts = await storedShop();
            const index = await parts.usage();
            const plainCard = deepFreeze({ tree: { component: 'text' }, exposes: [] }) as unknown as UiPartBodies['components'];

            // Act
            await parts.write('components', 'card', plainCard, 1);
            const afterWrite = deleteRule(index, { kind: 'components', name: 'badge' });
            await parts.delete('components', 'badge', 1);
            await parts.create({ kind: 'apps', name: 'kiosk', body: { ...SHOP, start: 'about' } });

            // Assert
            expect(afterWrite).toEqual({ kind: 'ok' });
            expect(index.has('components', 'badge')).toBe(false);
            expect(index.usedBy('themes', 'store')).toEqual([{ kind: 'apps', name: 'kiosk' }, { kind: 'apps', name: 'shop' }]);
            expect(index.usedBy('screens', 'about', 'kiosk')).toHaveLength(1);
        });

        it('should move a renamed part and keep the old name used by parts that still name it', async () => {
            // Arrange
            const parts = await storedShop();
            const index = await parts.usage();

            // Act
            await parts.rename('themes', 'store', 'brand');
            await parts.rename('apps', 'shop', 'store-front');

            // Assert
            expect(index.usedBy('themes', 'brand')).toEqual([]);
            expect(index.usedBy('themes', 'store')).toEqual([{ kind: 'apps', name: 'store-front' }]);
            expect(index.usedBy('screens', 'home', 'store-front')).toHaveLength(1);
            expect(index.has('apps', 'shop')).toBe(false);
        });

        it('should leave the index alone when a change is refused', async () => {
            // Arrange
            const parts = await storedShop();
            const index = await parts.usage();
            const plainCard = deepFreeze({ tree: { component: 'text' }, exposes: [] }) as unknown as UiPartBodies['components'];

            // Act
            const stale = await parts.write('components', 'card', plainCard, 9);

            // Assert
            expect(stale.kind).toBe('conflict');
            expect(index.usedBy('components', 'badge')).toEqual([{ kind: 'components', name: 'card' }]);
        });

        it('should tell the listeners of each change that succeeds, after the index took it, and none after they stop', async () => {
            // Arrange
            const parts = await storedShop();
            const index = await parts.usage();
            const plainCard = deepFreeze({ tree: { component: 'text' }, exposes: [] }) as unknown as UiPartBodies['components'];
            const heard: string[] = [];
            const seenIndexed: boolean[] = [];
            parts.onChange(() => {
                throw new Error('a failing listener');
            });
            const stop = parts.onChange((kind, name) => {
                heard.push(`${kind}:${name}`);
                seenIndexed.push(index.has(kind, name));
            });

            // Act
            await parts.write('components', 'card', plainCard, 1);
            await parts.write('components', 'card', plainCard, 9);
            await parts.rename('themes', 'store', 'brand');
            await parts.delete('components', 'badge', 1);
            await parts.create({ kind: 'themes', name: 'night', body: STORE_THEME });
            stop();
            await parts.create({ kind: 'themes', name: 'day', body: STORE_THEME });

            // Assert
            expect(heard).toEqual(['components:card', 'themes:brand', 'components:badge', 'themes:night']);
            expect(seenIndexed).toEqual([true, true, false, true]);
        });
    });
});
