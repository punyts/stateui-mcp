import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { DatasetNamespaces } from '../sync/DatasetNamespaces.js';
import { DatasetParts } from './DatasetParts.js';
import { FileNamespaceStore } from './FileNamespaceStore.js';
import { FilePartRepository } from './FilePartRepository.js';
import { KeyedLock } from './KeyedLock.js';
import { PartFolders } from './PartFolders.js';

const OWNER = '00000000-0000-4000-8000-0000000000cc';
const CATALOG = { model: 'product', records: { p1: { name: 'Lamp' } } } as unknown as UiPartBodies['data'];

let dir: string;
let files: FilePartRepository;
let namespaces: DatasetNamespaces;
let parts: DatasetParts;

/** The catalog's namespace as stored, read by a store of its own */
function stored(name: string): Promise<{ revision: number; state: unknown } | undefined> {
    return new FileNamespaceStore(dir).load(namespaces.address(name));
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-dataset-parts-'));
    files = new FilePartRepository(new PartFolders(dir), new KeyedLock());
    namespaces = new DatasetNamespaces(new FileNamespaceStore(dir), OWNER);
    parts = new DatasetParts(files, namespaces);
});

afterEach(async () => {
    await namespaces.close();
    await rm(dir, { recursive: true, force: true });
});

describe('DatasetParts', () => {
    it('should keep a dataset\'s records in its namespace and serve them with the part at the namespace\'s revision', async () => {
        // Act
        const created = await parts.create({ kind: 'data', name: 'catalog', body: CATALOG });
        const found = await parts.findByName('data', 'catalog');
        const file = await files.findByName('data', 'catalog');

        // Assert
        expect(created.kind).toBe('created');
        expect(found).toMatchObject({ name: 'catalog', revision: 1, body: CATALOG });
        expect(file?.body).toEqual({ model: 'product' });
        expect(await stored('catalog')).toMatchObject({ revision: 1, state: { data: { records: { p1: { name: 'Lamp' } } } } });
        expect(namespaces.address('catalog')).toBe(`${OWNER}/data/catalog`);
    });

    it('should write what changed in the records against the namespace\'s revision, and refuse a stale one', async () => {
        // Arrange
        await parts.create({ kind: 'data', name: 'catalog', body: CATALOG });
        const next = { model: 'product', records: { p1: { name: 'Lamp', price: 30 }, p2: { name: 'Chair' } } } as unknown as UiPartBodies['data'];

        // Act
        const written = await parts.write('data', 'catalog', next, 1);
        const stale = await parts.write('data', 'catalog', CATALOG, 1);

        // Assert
        expect(written).toEqual({ kind: 'written', revision: 3 });
        expect(stale).toEqual({ kind: 'conflict', currentRevision: 3 });
        expect((await parts.findByName('data', 'catalog'))?.body).toEqual(next);
        expect(await stored('catalog')).toMatchObject({ revision: 3 });
    });

    it('should move the namespace with a rename, one revision up, and remove it with a delete', async () => {
        // Arrange
        await parts.create({ kind: 'data', name: 'catalog', body: CATALOG });

        // Act
        const renamed = await parts.rename('data', 'catalog', 'products');
        const moved = await parts.findByName('data', 'products');
        const old = await stored('catalog');
        const deleted = await parts.delete('data', 'products', 2);

        // Assert
        expect(renamed).toMatchObject({ kind: 'renamed', revision: 2 });
        expect(moved).toMatchObject({ revision: 2, body: CATALOG });
        expect(old).toBeUndefined();
        expect(deleted).toEqual({ kind: 'deleted' });
        expect(await stored('products')).toBeUndefined();
        await expect(readFile(join(dir, 'names.json'), 'utf8')).resolves.not.toContain('products');
    });
});
