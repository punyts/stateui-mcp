import { describe, expect, it, vi } from 'vitest';
import type { UiPartBodies } from '../domain/UiPart.js';
import { partReferences } from '../domain/partReferences.js';
import { InMemoryUiPartRepository } from '../testing/InMemoryUiPartRepository.js';
import { loadPartSource } from './partSource.js';

const body = <K extends keyof UiPartBodies>(value: object): UiPartBodies[K] => value as unknown as UiPartBodies[K];

const SHOP = body<'apps'>({
    uses: { themes: ['brand'], data: { stock: { dataset: 'stock' } } },
    app: { component: 'stack' },
    screens: { home: { root: { component: 'stack', children: { a: { component: 'card' }, b: { component: 'text' }, c: { component: 'button' }, d: { component: 'image' } } } } },
    start: 'home'
});

async function owner() {
    const parts = new InMemoryUiPartRepository();
    await parts.create({ kind: 'models', name: 'product', body: body<'models'>({ fields: { title: { type: 'string' } } }) });
    await parts.create({ kind: 'data', name: 'stock', body: body<'data'>({ model: 'product', records: { a: { title: 'Lamp' } } }) });
    await parts.create({ kind: 'themes', name: 'brand', body: body<'themes'>({ tokens: { color: { accent: '#3047d8' } } }) });
    await parts.create({ kind: 'components', name: 'card', body: body<'components'>({ tree: { component: 'stack', children: { title: { component: 'text' } } } }) });
    await parts.create({ kind: 'components', name: 'banner', body: body<'components'>({ tree: { component: 'text' } }) });
    return parts;
}

describe('loadPartSource', () => {
    it('should load the parts an app reaches and every component of the owner when it names a library component', async () => {
        // Arrange
        const parts = await owner();

        // Act
        const source = await loadPartSource(parts, partReferences('apps', SHOP));

        // Assert
        expect(Object.keys(source.themes ?? {})).toEqual(['brand']);
        expect(Object.keys(source.datasets ?? {})).toEqual(['stock']);
        expect(Object.keys(source.models ?? {})).toEqual(['product']);
        expect(Object.keys(source.components ?? {}).sort()).toEqual(['banner', 'card']);
    });

    it('should read no part for a name the owner has none of, listing each kind once', async () => {
        // Arrange
        const parts = await owner();
        const find = vi.spyOn(parts, 'findByName');
        const list = vi.spyOn(parts, 'list');

        // Act
        await loadPartSource(parts, partReferences('apps', SHOP));

        // Assert
        expect(find.mock.calls.map(([kind, name]) => `${kind}/${name}`).sort()).toEqual(['components/banner', 'components/card', 'data/stock', 'models/product', 'themes/brand']);
        expect(list.mock.calls.map(([kind]) => kind).sort()).toEqual(['components', 'data', 'models', 'themes']);
    });
});
