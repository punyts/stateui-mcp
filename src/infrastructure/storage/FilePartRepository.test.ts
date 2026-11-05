import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { FilePartRepository } from './FilePartRepository.js';
import { KeyedLock } from './KeyedLock.js';
import { PartFolders } from './PartFolders.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const PRODUCT_ID = '00000000-0000-4000-8000-000000000001';

/** `children` in an order that is not sorted, and records `a`, `b`, `c` written as `c`, `a`, `b` */
const COMPONENT: UiPartBodies['components'] = Object.freeze({
    root: Object.freeze({
        component: 'stack',
        children: Object.freeze({ zeta: Object.freeze({ component: 'text' }), alpha: Object.freeze({ component: 'text' }), mid: Object.freeze({ component: 'text' }) })
    })
}) as unknown as UiPartBodies['components'];

const DATASET: UiPartBodies['data'] = Object.freeze({
    records: Object.freeze({ c: Object.freeze({ n: 3 }), a: Object.freeze({ n: 1 }), b: Object.freeze({ n: 2 }) })
}) as unknown as UiPartBodies['data'];

let dir: string;
let folders: PartFolders;

function repository(): FilePartRepository {
    let next = 0;
    return new FilePartRepository(folders, new KeyedLock(), { now: () => NOW, newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}` });
}

async function namesJson(): Promise<unknown> {
    return JSON.parse(await readFile(folders.namesFile(), 'utf8')) as unknown;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-parts-'));
    folders = new PartFolders(dir);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('PartFolders', () => {
    it('should build part paths from a kind and a UUID only', () => {
        // Act, Assert
        expect(folders.partFile('themes', PRODUCT_ID.toUpperCase())).toBe(join(dir, 'themes', `${PRODUCT_ID}.json`));
        expect(() => folders.partFile('themes', '../escape')).toThrow('UUID');
        expect(() => folders.partFile('../escape' as 'themes', PRODUCT_ID)).toThrow('Not a part kind');
        expect(() => folders.kindDir('personas' as 'themes')).toThrow('Not a part kind');
        expect(() => folders.dir('../escape')).toThrow('UUID');
        expect(() => folders.fileBytes(PRODUCT_ID, '..')).toThrow('UUID');
    });
});

describe('FilePartRepository', () => {
    it('should write one file per part named by its id and an index of names', async () => {
        // Arrange
        const parts = repository();

        // Act
        await parts.create({ kind: 'data', name: 'product', body: DATASET });
        const file = JSON.parse(await readFile(folders.partFile('data', PRODUCT_ID), 'utf8')) as Record<string, unknown>;

        // Assert
        expect(await readdir(join(dir, 'data'))).toEqual([`${PRODUCT_ID}.json`]);
        expect(Object.keys(file)).toEqual(['id', 'kind', 'name', 'revision', 'createdAt', 'updatedAt', 'body']);
        expect(file['name']).toBe('product');
        expect(await namesJson()).toEqual({ apps: {}, themes: {}, logic: {}, models: {}, data: { product: PRODUCT_ID }, components: {}, patterns: {} });
    });

    it('should keep the order of keyed maps through a write and a read, against sorted keys', async () => {
        // Arrange
        const parts = repository();
        await parts.create({ kind: 'data', name: 'product', body: DATASET });
        await parts.create({ kind: 'components', name: 'card', body: COMPONENT });

        // Act
        await parts.write('data', 'product', DATASET, 1);
        const records = (await repository().findByName('data', 'product'))?.body.records ?? {};
        const card = (await repository().findByName('components', 'card'))?.body as unknown as typeof COMPONENT & { root: { children: object } };

        // Assert
        expect(Object.keys(records)).toEqual(['c', 'a', 'b']);
        expect(Object.keys(records)).not.toEqual(Object.keys(records).sort());
        expect(Object.keys(card.root.children)).toEqual(['zeta', 'alpha', 'mid']);
    });

    it('should rebuild names.json from the part files when it is missing', async () => {
        // Arrange
        const first = repository();
        await first.create({ kind: 'data', name: 'product', body: DATASET });
        await first.rename('data', 'product', 'item');
        await rm(folders.namesFile());

        // Act
        const restarted = repository();
        const found = await restarted.findByName('data', 'item');

        // Assert
        expect(found?.id).toBe(PRODUCT_ID);
        expect(await restarted.findByName('data', 'product')).toBeUndefined();
        expect(await namesJson()).toMatchObject({ data: { item: PRODUCT_ID } });
    });

    it('should trust the part files over a names.json that disagrees', async () => {
        // Arrange
        await repository().create({ kind: 'data', name: 'product', body: DATASET });
        await writeFile(folders.namesFile(), JSON.stringify({ data: { stale: PRODUCT_ID, ghost: '00000000-0000-4000-8000-000000000099' } }));

        // Act
        const restarted = repository();
        const listed = await restarted.list('data');

        // Assert
        expect(listed.map((part) => part.name)).toEqual(['product']);
        expect(await restarted.findByName('data', 'ghost')).toBeUndefined();
        expect(await namesJson()).toMatchObject({ data: { product: PRODUCT_ID } });
    });

    it('should leave the part file and the index in step after a delete', async () => {
        // Arrange
        const parts = repository();
        await parts.create({ kind: 'data', name: 'product', body: DATASET });

        // Act
        await parts.delete('data', 'product', 1);

        // Assert
        expect(await readdir(join(dir, 'data'))).toEqual([]);
        expect(await namesJson()).toMatchObject({ data: {} });
    });

    it('should report a damaged part file instead of skipping it', async () => {
        // Arrange
        await repository().create({ kind: 'data', name: 'product', body: DATASET });
        await writeFile(folders.partFile('data', PRODUCT_ID), JSON.stringify({ id: PRODUCT_ID }));

        // Act, Assert
        await expect(repository().list('data')).rejects.toThrow(`data/${PRODUCT_ID}.json is damaged`);
    });

    it('should ignore files in a kind folder that are not part files', async () => {
        // Arrange
        await repository().create({ kind: 'data', name: 'product', body: DATASET });
        await writeFile(join(dir, 'data', `${PRODUCT_ID}.json.1234.tmp`), '{');
        await writeFile(join(dir, 'data', 'notes.txt'), 'x');

        // Act
        const listed = await repository().list('data');

        // Assert
        expect(listed.map((part) => part.name)).toEqual(['product']);
    });
});
