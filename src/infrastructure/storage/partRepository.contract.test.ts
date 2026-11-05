import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../../testing/InMemoryUiPartRepository.js';
import { FilePartRepository } from './FilePartRepository.js';
import { KeyedLock } from './KeyedLock.js';
import { PartFolders } from './PartFolders.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');

const MODEL: UiPartBodies['models'] = Object.freeze({
    fields: Object.freeze({ zeta: Object.freeze({ type: 'string' }), alpha: Object.freeze({ type: 'number' }), mid: Object.freeze({ type: 'boolean' }) })
}) as UiPartBodies['models'];

function idOf(n: number): string {
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function sequence(): () => string {
    let next = 0;
    return () => idOf(++next);
}

const temporaryDirs: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ADAPTERS: ReadonlyArray<readonly [string, () => Promise<UiPartRepository>]> = [
    ['InMemoryUiPartRepository', async () => new InMemoryUiPartRepository({ newId: sequence(), now: () => NOW })],
    [
        'FilePartRepository',
        async () => {
            const dir = await mkdtemp(join(tmpdir(), 'stateui-parts-'));
            temporaryDirs.push(dir);
            return new FilePartRepository(new PartFolders(dir), new KeyedLock(), { newId: sequence(), now: () => NOW });
        }
    ]
];

describe.each(ADAPTERS)('UiPartRepository contract: %s', (_name, createRepository) => {
    it('should create a part and find it by name and by id with its key order', async () => {
        // Arrange
        const parts = await createRepository();

        // Act
        const created = await parts.create({ kind: 'models', name: 'product', body: MODEL });
        const byName = await parts.findByName('models', 'product');
        const byId = await parts.findById('models', idOf(1));

        // Assert
        expect(created).toEqual({ kind: 'created', part: { id: idOf(1), kind: 'models', name: 'product', revision: 1, body: MODEL, createdAt: NOW, updatedAt: NOW } });
        expect(byName).toEqual(byId);
        expect(byName).toEqual(created.kind === 'created' ? created.part : undefined);
        expect(Object.keys(byName?.body.fields ?? {})).toEqual(['zeta', 'alpha', 'mid']);
    });

    it('should refuse a second part of one name in a kind and allow it in another kind', async () => {
        // Arrange
        const parts = await createRepository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });

        // Act
        const again = await parts.create({ kind: 'models', name: 'product', body: MODEL });
        const otherKind = await parts.create({ kind: 'data', name: 'product', body: { records: {} } });

        // Assert
        expect(again).toEqual({ kind: 'duplicate-name' });
        expect(otherKind.kind).toBe('created');
    });

    it('should let only one of two concurrent creates of one name win', async () => {
        // Arrange
        const parts = await createRepository();

        // Act
        const results = await Promise.all([parts.create({ kind: 'models', name: 'product', body: MODEL }), parts.create({ kind: 'models', name: 'product', body: MODEL })]);

        // Assert
        expect(results.map((result) => result.kind).sort()).toEqual(['created', 'duplicate-name']);
        expect(await parts.list('models')).toHaveLength(1);
    });

    it('should refuse a name that is not a slug, a body that is not an object and an unknown kind', async () => {
        // Arrange
        const parts = await createRepository();

        // Act
        const badName = await parts.create({ kind: 'models', name: 'Product', body: MODEL });
        const badBody = await parts.create({ kind: 'models', name: 'product', body: [] as never });
        const badKind = await parts.create({ kind: 'personas' as 'models', name: 'product', body: MODEL });

        // Assert
        expect(badName.kind).toBe('invalid');
        expect(badBody).toEqual({ kind: 'invalid', reason: 'a part body must be a JSON object' });
        expect(badKind).toEqual({ kind: 'invalid', reason: '"personas" is not a part kind' });
        expect(await parts.list('models')).toEqual([]);
    });

    it('should write with the current revision and refuse a stale one', async () => {
        // Arrange
        const parts = await createRepository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });
        const body = Object.freeze({ fields: Object.freeze({ name: Object.freeze({ type: 'string' }) }) }) as UiPartBodies['models'];

        // Act
        const written = await parts.write('models', 'product', body, 1);
        const stale = await parts.write('models', 'product', MODEL, 1);
        const missing = await parts.write('models', 'nothing', MODEL, 1);
        const notObject = await parts.write('models', 'product', 'text' as never, 2);

        // Assert
        expect(written).toEqual({ kind: 'written', revision: 2 });
        expect(stale).toEqual({ kind: 'conflict', currentRevision: 2 });
        expect(missing).toEqual({ kind: 'not-found' });
        expect(notObject.kind).toBe('invalid');
        expect((await parts.findByName('models', 'product'))?.body).toEqual(body);
    });

    it('should let exactly one of two concurrent writes with one expected revision win', async () => {
        // Arrange
        const parts = await createRepository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });
        const first = { fields: { first: { type: 'string' } } } as UiPartBodies['models'];
        const second = { fields: { second: { type: 'string' } } } as UiPartBodies['models'];

        // Act
        const results = await Promise.all([parts.write('models', 'product', first, 1), parts.write('models', 'product', second, 1)]);

        // Assert
        expect(results).toEqual([{ kind: 'written', revision: 2 }, { kind: 'conflict', currentRevision: 2 }]);
        expect((await parts.findByName('models', 'product'))?.body).toEqual(first);
    });

    it('should keep the stored part when the caller changes what it passed or got', async () => {
        // Arrange
        const parts = await createRepository();
        const body = JSON.parse(JSON.stringify(MODEL)) as UiPartBodies['models'];
        await parts.create({ kind: 'models', name: 'product', body });

        // Act
        body.fields['extra'] = { type: 'any' };
        const found = await parts.findByName('models', 'product');
        if (found) found.body.fields['other'] = { type: 'any' };

        // Assert
        expect((await parts.findByName('models', 'product'))?.body).toEqual(MODEL);
    });

    it('should list the parts of a kind in name order without bodies', async () => {
        // Arrange
        const parts = await createRepository();
        for (const name of ['order', 'customer', 'product']) await parts.create({ kind: 'models', name, body: MODEL });

        // Act
        const listed = await parts.list('models');

        // Assert
        expect(listed.map((part) => part.name)).toEqual(['customer', 'order', 'product']);
        expect(listed[0]).toEqual({ id: idOf(2), kind: 'models', name: 'customer', revision: 1, updatedAt: NOW });
        expect(await parts.list('themes')).toEqual([]);
    });

    it('should rename a part, keep its id and free the old name', async () => {
        // Arrange
        const parts = await createRepository();
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
        expect(renamed).toEqual({ kind: 'renamed', revision: 2, rewritten: [] });
        expect((await parts.findByName('models', 'item'))?.id).toBe(idOf(1));
        expect(await parts.findByName('models', 'product')).toBeUndefined();
        expect((await parts.list('models')).map((part) => part.name)).toEqual(['item', 'order']);
    });

    it('should write the new bodies of the rewritten parts with the rename, each one revision up', async () => {
        // Arrange
        const parts = await createRepository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });
        await parts.create({ kind: 'data', name: 'stock', body: { model: 'product', records: {} } as never });
        const dataset = { model: 'item', records: {} };

        // Act
        const renamed = await parts.rename('models', 'product', 'item', [{ kind: 'data', name: 'stock', body: dataset, expectedRevision: 1 }]);

        // Assert
        expect(renamed).toEqual({ kind: 'renamed', revision: 2, rewritten: [{ kind: 'data', name: 'stock', revision: 2 }] });
        expect((await parts.findByName('data', 'stock'))?.body).toEqual(dataset);
        expect((await parts.findByName('models', 'item'))?.revision).toBe(2);
    });

    it('should refuse a rename whose rewritten part moved since it was read, and change nothing', async () => {
        // Arrange
        const parts = await createRepository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });
        await parts.create({ kind: 'data', name: 'stock', body: { model: 'product', records: {} } as never });

        // Act
        const stale = await parts.rename('models', 'product', 'item', [{ kind: 'data', name: 'stock', body: { model: 'item', records: {} }, expectedRevision: 4 }]);
        const gone = await parts.rename('models', 'product', 'item', [{ kind: 'data', name: 'nothing', body: {}, expectedRevision: 1 }]);

        // Assert
        expect(stale).toEqual({ kind: 'conflict', part: { kind: 'data', name: 'stock' }, currentRevision: 1 });
        expect(gone).toEqual({ kind: 'conflict', part: { kind: 'data', name: 'nothing' }, currentRevision: 0 });
        expect((await parts.findByName('models', 'product'))?.revision).toBe(1);
        expect((await parts.findByName('data', 'stock'))?.body).toEqual({ model: 'product', records: {} });
    });

    it('should delete with the current revision only', async () => {
        // Arrange
        const parts = await createRepository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });

        // Act
        const stale = await parts.delete('models', 'product', 7);
        const deleted = await parts.delete('models', 'product', 1);
        const again = await parts.delete('models', 'product', 1);

        // Assert
        expect([stale, deleted, again]).toEqual([{ kind: 'conflict', currentRevision: 1 }, { kind: 'deleted' }, { kind: 'not-found' }]);
        expect(await parts.findById('models', idOf(1))).toBeUndefined();
        expect((await parts.create({ kind: 'models', name: 'product', body: MODEL })).kind).toBe('created');
    });

    it('should not find a part by id under another kind', async () => {
        // Arrange
        const parts = await createRepository();
        await parts.create({ kind: 'models', name: 'product', body: MODEL });

        // Act, Assert
        expect(await parts.findById('data', idOf(1))).toBeUndefined();
    });
});
