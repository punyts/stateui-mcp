import { describe, expect, it } from 'vitest';
import type { UiPartBodies } from '../domain/UiPart.js';
import { InMemoryUiPartRepository } from './InMemoryUiPartRepository.js';

const NOW = new Date('2026-11-04T10:00:00Z');

const MODEL: UiPartBodies['models'] = Object.freeze({
    fields: Object.freeze({ zeta: Object.freeze({ type: 'string' }), alpha: Object.freeze({ type: 'number' }), mid: Object.freeze({ type: 'boolean' }) })
}) as UiPartBodies['models'];

function repository(): InMemoryUiPartRepository {
    let next = 0;
    return new InMemoryUiPartRepository({ newId: () => `id-${++next}`, now: () => NOW });
}

describe('InMemoryUiPartRepository', () => {
    it('should create a part and find it by name and by id with its key order', async () => {
        // Arrange
        const parts = repository();

        // Act
        const created = await parts.create({ kind: 'models', name: 'product', body: MODEL });
        const byName = await parts.findByName('models', 'product');
        const byId = await parts.findById('models', 'id-1');

        // Assert
        expect(created).toEqual({ kind: 'created', part: { id: 'id-1', kind: 'models', name: 'product', revision: 1, body: MODEL, createdAt: NOW, updatedAt: NOW } });
        expect(byName).toEqual(byId);
        expect(Object.keys(byName?.body.fields ?? {})).toEqual(['zeta', 'alpha', 'mid']);
    });

    it('should refuse a second part of one name in a kind and allow it in another kind', async () => {
        // Arrange
        const parts = repository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });

        // Act
        const again = await parts.create({ kind: 'models', name: 'product', body: MODEL });
        const otherKind = await parts.create({ kind: 'data', name: 'product', body: { records: {} } });

        // Assert
        expect(again).toEqual({ kind: 'duplicate-name' });
        expect(otherKind.kind).toBe('created');
    });

    it('should refuse a name that is not a slug and a body that is not an object', async () => {
        // Arrange
        const parts = repository();

        // Act
        const badName = await parts.create({ kind: 'models', name: 'Product', body: MODEL });
        const badBody = await parts.create({ kind: 'models', name: 'product', body: [] as never });

        // Assert
        expect(badName.kind).toBe('invalid');
        expect(badBody).toEqual({ kind: 'invalid', reason: 'a part body must be a JSON object' });
        expect(await parts.list('models')).toEqual([]);
    });

    it('should write with the current revision and refuse a stale one', async () => {
        // Arrange
        const parts = repository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });
        const body = { fields: { name: { type: 'string' } } } as UiPartBodies['models'];

        // Act
        const written = await parts.write('models', 'product', body, 1);
        const stale = await parts.write('models', 'product', MODEL, 1);
        const missing = await parts.write('models', 'nothing', MODEL, 1);

        // Assert
        expect(written).toEqual({ kind: 'written', revision: 2 });
        expect(stale).toEqual({ kind: 'conflict', currentRevision: 2 });
        expect(missing).toEqual({ kind: 'not-found' });
        expect((await parts.findByName('models', 'product'))?.body).toEqual(body);
    });

    it('should keep the stored part when the caller changes what it passed or got', async () => {
        // Arrange
        const parts = repository();
        const body = JSON.parse(JSON.stringify(MODEL)) as UiPartBodies['models'];
        await parts.create({ kind: 'models', name: 'product', body });

        // Act
        body.fields['extra'] = { type: 'any' };
        const found = await parts.findByName('models', 'product');
        if (found) found.body.fields['other'] = { type: 'any' };

        // Assert
        expect((await parts.findByName('models', 'product'))?.body).toEqual(MODEL);
    });

    it('should rename a part, keep its id and free the old name', async () => {
        // Arrange
        const parts = repository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });
        await parts.create({ kind: 'models', name: 'order', body: MODEL });

        // Act
        const taken = await parts.rename('models', 'product', 'order');
        const invalid = await parts.rename('models', 'product', 'Item');
        const missing = await parts.rename('models', 'nothing', 'item');
        const renamed = await parts.rename('models', 'product', 'item');

        // Assert
        expect([taken, missing]).toEqual([{ kind: 'duplicate-name' }, { kind: 'not-found' }]);
        expect(invalid.kind).toBe('invalid');
        expect(renamed).toEqual({ kind: 'renamed', revision: 2 });
        expect((await parts.findByName('models', 'item'))?.id).toBe('id-1');
        expect(await parts.findByName('models', 'product')).toBeUndefined();
        expect((await parts.list('models')).map((part) => part.name)).toEqual(['item', 'order']);
    });

    it('should delete with the current revision only', async () => {
        // Arrange
        const parts = repository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });

        // Act
        const stale = await parts.delete('models', 'product', 7);
        const deleted = await parts.delete('models', 'product', 1);
        const again = await parts.delete('models', 'product', 1);

        // Assert
        expect([stale, deleted, again]).toEqual([{ kind: 'conflict', currentRevision: 1 }, { kind: 'deleted' }, { kind: 'not-found' }]);
        expect(await parts.findById('models', 'id-1')).toBeUndefined();
    });

    it('should not find a part by id under another kind', async () => {
        // Arrange
        const parts = repository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });

        // Act, Assert
        expect(await parts.findById('data', 'id-1')).toBeUndefined();
    });
});
