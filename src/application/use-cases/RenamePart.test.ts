import { describe, expect, it, vi } from 'vitest';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../../testing/InMemoryUiPartRepository.js';
import { IndexedUiPartRepository } from '../IndexedUiPartRepository.js';
import { RENAME_ATTEMPTS, RenamePart } from './RenamePart.js';

const REPORT = Object.freeze({ info: vi.fn() });
const PRODUCT = Object.freeze({ fields: Object.freeze({}) }) as unknown as UiPartBodies['models'];
const STOCK = Object.freeze({ model: 'product', records: Object.freeze({}) }) as unknown as UiPartBodies['data'];
/** A component whose tree names itself, as a nested list might */
const TREE = Object.freeze({ tree: Object.freeze({ component: 'stack', children: Object.freeze({ inner: Object.freeze({ component: 'tree' }) }) }) }) as unknown as UiPartBodies['components'];

async function setUp() {
    const inner = new InMemoryUiPartRepository();
    const parts = new IndexedUiPartRepository(inner);
    await parts.create({ kind: 'models', name: 'product', body: PRODUCT });
    await parts.create({ kind: 'data', name: 'stock', body: STOCK });
    await parts.create({ kind: 'components', name: 'tree', body: TREE });
    return { inner, parts, rename: new RenamePart(parts, parts, REPORT) };
}

describe('RenamePart', () => {
    it('should read the parts again and retry when a rewritten part moved, then succeed', async () => {
        // Arrange
        const { inner, parts, rename } = await setUp();
        const real = inner.rename.bind(inner);
        const spy = vi.spyOn(inner, 'rename').mockImplementationOnce(async () => ({ kind: 'conflict', part: { kind: 'data', name: 'stock' }, currentRevision: 2 }));
        spy.mockImplementation(real);

        // Act
        const result = await rename.execute({ kind: 'models', name: 'product', to: 'item' });

        // Assert
        expect(spy).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ kind: 'renamed', revision: 2, rewritten: [{ kind: 'data', name: 'stock', revision: 2 }] });
        expect((await parts.findByName('data', 'stock'))?.body).toEqual({ model: 'item', records: {} });
    });

    it('should give a conflict when the parts keep moving', async () => {
        // Arrange
        const { inner, rename } = await setUp();
        const spy = vi.spyOn(inner, 'rename').mockResolvedValue({ kind: 'conflict', part: { kind: 'data', name: 'stock' }, currentRevision: 9 });

        // Act
        const result = await rename.execute({ kind: 'models', name: 'product', to: 'item' });

        // Assert
        expect(spy).toHaveBeenCalledTimes(RENAME_ATTEMPTS);
        expect(result).toEqual({ kind: 'conflict', currentRevision: 9 });
    });

    it('should rewrite a part that names itself in the same revision as its rename', async () => {
        // Arrange
        const { parts, rename } = await setUp();
        const changes: string[] = [];
        parts.onChange((kind, name) => changes.push(`${kind}:${name}`));

        // Act
        const result = await rename.execute({ kind: 'components', name: 'tree', to: 'outline' });

        // Assert
        expect(result).toEqual({ kind: 'renamed', revision: 2, rewritten: [] });
        expect((await parts.findByName('components', 'outline'))?.body).toEqual({ tree: { component: 'stack', children: { inner: { component: 'outline' } } } });
        expect((await parts.usage()).usedBy('components', 'outline')).toEqual([]);
        expect(changes).toEqual(['components:outline']);
    });

    it('should tell the listeners of the renamed part and each rewritten part', async () => {
        // Arrange
        const { parts, rename } = await setUp();
        const changes: string[] = [];
        parts.onChange((kind, name) => changes.push(`${kind}:${name}`));

        // Act
        await rename.execute({ kind: 'models', name: 'product', to: 'item' });

        // Assert
        expect(changes).toEqual(['models:item', 'data:stock']);
        expect((await parts.usage()).usedBy('models', 'item')).toEqual([{ kind: 'data', name: 'stock' }]);
    });

    it('should not find a screen of an app that does not exist or has no such screen', async () => {
        // Arrange
        const { parts, rename } = await setUp();
        await parts.create({ kind: 'apps', name: 'shop', body: { screens: { home: {} } } as never });

        // Act
        const results = [
            await rename.execute({ kind: 'screens', app: 'nothing', name: 'home', to: 'start', expectedRevision: 1 }),
            await rename.execute({ kind: 'screens', app: 'shop', name: 'about', to: 'story', expectedRevision: 1 }),
            await rename.execute({ kind: 'screens', app: 'shop', name: 'home', to: 'Start', expectedRevision: 1 })
        ];

        // Assert
        expect(results.map((result) => result.kind)).toEqual(['not-found', 'not-found', 'invalid']);
    });
});
