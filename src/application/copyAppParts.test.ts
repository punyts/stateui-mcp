import { describe, expect, it } from 'vitest';
import type { UiPartBodies } from '../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../testing/InMemoryUiPartRepository.js';
import { copyAppParts } from './copyAppParts.js';

const body = <K extends keyof UiPartBodies>(value: object): UiPartBodies[K] => value as unknown as UiPartBodies[K];

const PRODUCT = body<'models'>({ fields: { title: { type: 'string' } } });
const STOCK = body<'data'>({ model: 'product', records: { a: { title: 'Lamp' } } });
const BRAND = body<'themes'>({ tokens: { color: { accent: '#3047d8' } } });
const CARD = body<'components'>({ tree: { component: 'stack', children: { title: { component: 'text' } } } });
const SHOP = body<'apps'>({
    uses: { themes: ['brand'], data: { stock: { dataset: 'stock' } } },
    app: { component: 'stack' },
    screens: { home: { root: { component: 'card' } } },
    start: 'home'
});

async function source() {
    const parts = new InMemoryUiPartRepository();
    await parts.create({ kind: 'models', name: 'product', body: PRODUCT });
    await parts.create({ kind: 'data', name: 'stock', body: STOCK });
    await parts.create({ kind: 'themes', name: 'brand', body: BRAND });
    await parts.create({ kind: 'components', name: 'card', body: CARD });
    const app = await parts.create({ kind: 'apps', name: 'shop', body: SHOP });
    if (app.kind !== 'created') throw new Error('no app');
    return { parts, appId: app.part.id };
}

describe('copyAppParts', () => {
    it('should copy the app and every part it reaches into an empty target', async () => {
        // Arrange
        const { parts, appId } = await source();
        const target = new InMemoryUiPartRepository();

        // Act
        const result = await copyAppParts(parts, target, appId);

        // Assert
        expect(result.kind).toBe('copied');
        if (result.kind !== 'copied') return;
        expect(result.app.name).toBe('shop');
        expect(result.app.id).not.toBe(appId);
        expect(result.app.body).toEqual(SHOP);
        expect(result.parts.map((part) => `${part.kind}/${part.name}`).sort()).toEqual(['components/card', 'data/stock', 'models/product', 'themes/brand']);
        expect((await target.findByName('data', 'stock'))?.body).toEqual(STOCK);
    });

    it('should reuse a part the target has with the same body, rename one it has with another, and rewrite what names it', async () => {
        // Arrange
        const { parts, appId } = await source();
        const target = new InMemoryUiPartRepository();
        await target.create({ kind: 'models', name: 'product', body: PRODUCT });
        await target.create({ kind: 'themes', name: 'brand', body: body<'themes'>({ tokens: {} }) });
        await target.create({ kind: 'components', name: 'card', body: body<'components'>({ tree: { component: 'text' } }) });
        await target.create({ kind: 'apps', name: 'shop', body: SHOP });

        // Act
        const result = await copyAppParts(parts, target, appId);

        // Assert
        expect(result.kind).toBe('copied');
        if (result.kind !== 'copied') return;
        expect(result.app.name).toBe('shop-2');
        expect(result.parts).toEqual(expect.arrayContaining([
            { kind: 'themes', name: 'brand-2', from: 'brand' },
            { kind: 'components', name: 'card-2', from: 'card' },
            { kind: 'data', name: 'stock' }
        ]));
        expect(result.parts.some((part) => part.kind === 'models')).toBe(false);
        const app = result.app.body as unknown as { uses: { themes: string[] }; screens: { home: { root: { component: string } } } };
        expect(app.uses.themes).toEqual(['brand-2']);
        expect(app.screens.home.root.component).toBe('card-2');
        expect((await target.findByName('themes', 'brand-2'))?.body).toEqual(BRAND);
        expect((await target.findByName('themes', 'brand'))?.body).toEqual({ tokens: {} });
    });

    it('should copy under the name given and say when the app is not found', async () => {
        // Arrange
        const { parts, appId } = await source();
        const target = new InMemoryUiPartRepository();

        // Act
        const named = await copyAppParts(parts, target, appId, { name: 'my-shop' });
        const missing = await copyAppParts(parts, target, '00000000-0000-4000-8000-0000000000ff');

        // Assert
        expect(named.kind === 'copied' && named.app.name).toBe('my-shop');
        expect(missing).toEqual({ kind: 'not-found' });
    });
});
