import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedUiPartRepository } from '../src/application/IndexedUiPartRepository.js';
import { RenamePart } from '../src/application/use-cases/RenamePart.js';
import { FilePartRepository } from '../src/infrastructure/storage/FilePartRepository.js';
import { KeyedLock } from '../src/infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../src/infrastructure/storage/PartFolders.js';
import { httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const REPORT = Object.freeze({ info: (): void => undefined });

let data: TempData | undefined;
let harness: HttpHarness | undefined;

afterEach(async () => {
    await harness?.close();
    await data?.cleanup();
    harness = undefined;
    data = undefined;
});

describe('a part rename stopped halfway, at server start', () => {
    it('should be finished before the server reads a part', async () => {
        // Arrange
        data = await tempData();
        const folders = new PartFolders(data.dir);
        let partWrites = 0;
        const files = new FilePartRepository(folders, new KeyedLock(), {
            afterRenameWrite: (path) => {
                if (path === folders.renameJournal() || path === folders.namesFile()) return;
                partWrites += 1;
                if (partWrites === 2) throw new Error('the process stopped');
            }
        });
        const parts = new IndexedUiPartRepository(files);
        await parts.create({ kind: 'models', name: 'product', body: { fields: {} } as never });
        await parts.create({ kind: 'data', name: 'stock', body: { model: 'product', records: {} } as never });
        await parts.create({ kind: 'data', name: 'sale', body: { model: 'product', records: {} } as never });
        await expect(new RenamePart(parts, parts, REPORT).execute({ kind: 'models', name: 'product', to: 'item' })).rejects.toThrow('stopped');

        // Act
        harness = await httpHarness(data.dir);
        const names = JSON.parse(await readFile(folders.namesFile(), 'utf8')) as { models: Record<string, string> };
        const journal = await readFile(folders.renameJournal(), 'utf8').catch(() => undefined);

        // Assert
        expect(Object.keys(names.models)).toEqual(['item']);
        expect(journal).toBeUndefined();
        const restarted = new FilePartRepository(folders, new KeyedLock());
        for (const name of ['stock', 'sale']) expect((await restarted.findByName('data', name))?.body).toEqual({ model: 'item', records: {} });
    });
});
