import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PREVIEW_ERRORS } from '../../domain/limits.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { PartFolders } from './PartFolders.js';
import { writeFileAtomic } from './atomicFile.js';
import { FileUiAppRepository } from './FileUiAppRepository.js';
import { FileUiErrorLog } from './FileUiErrorLog.js';
import { FileUiFileRepository } from './FileUiFileRepository.js';
import { FsUiFileStore } from './FsUiFileStore.js';
import { KeyedLock } from './KeyedLock.js';
import { AppAuthorities } from '../sync/AppAuthorities.js';
import { FileNamespaceStorage } from '../sync/FileNamespaceStorage.js';

let dir: string;
let folders: PartFolders;
let lock: KeyedLock;
let apps: FileUiAppRepository;
let authorities: AppAuthorities;

function createAuthorities(): AppAuthorities {
    return new AppAuthorities(new FileNamespaceStorage(folders), () => undefined);
}

const ORDERED: UiDocument = {
    app: { component: 'page', children: { zeta: { component: 'text' }, a: { component: 'text' }, mm: { component: 'text' } } },
    data: { rows: { zz: { n: 1 }, aa: { n: 2 } } }
};

async function createApp(name = 'one', document: UiDocument = ORDERED): Promise<string> {
    const created = await apps.create({ name, document, sync: 'full' });
    if (created.kind !== 'created') throw new Error('not created');
    return created.app.id;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-mcp-'));
    folders = new PartFolders(dir);
    lock = new KeyedLock();
    authorities = createAuthorities();
    apps = new FileUiAppRepository(folders, lock, authorities);
});

afterEach(async () => {
    await authorities.close();
    await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
    it('should replace the content and leave no temporary file behind', async () => {
        const target = join(dir, 'a', 'value.json');

        await writeFileAtomic(target, '1');
        await writeFileAtomic(target, '2');

        expect(await readFile(target, 'utf8')).toBe('2');
        expect(await readdir(join(dir, 'a'))).toEqual(['value.json']);
    });

    it('should never show a reader a half-written file while writes race', async () => {
        const target = join(dir, 'race.json');
        const big = (n: number): string => JSON.stringify({ n, filler: 'x'.repeat(200_000) });
        await writeFileAtomic(target, big(0));

        const writes = Array.from({ length: 20 }, (_, n) => writeFileAtomic(target, big(n)));
        const reads = Array.from({ length: 40 }, async () => JSON.parse(await readFile(target, 'utf8')) as { n: number });
        await Promise.all(writes);
        const seen = await Promise.all(reads);

        expect(seen.every((value) => typeof value.n === 'number')).toBe(true);
        expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
});

describe('PartFolders', () => {
    it('should refuse an id that is not a UUID', () => {
        expect(() => folders.dir('../escape')).toThrow('UUID');
        expect(() => folders.fileBytes('11111111-1111-4111-8111-111111111111', '..')).toThrow('UUID');
    });
});

describe('FileUiAppRepository', () => {
    it('should keep the key order of children and keyed data maps on disk and after a read', async () => {
        const id = await createApp();

        const text = await readFile(folders.appFile(id), 'utf8');
        const found = await apps.findById(id);

        expect(text.indexOf('"zeta"')).toBeLessThan(text.indexOf('"a"'));
        expect(Object.keys((found?.document['app'] as { children: object }).children)).toEqual(['zeta', 'a', 'mm']);
        expect(Object.keys((found?.document['data'] as { rows: object }).rows)).toEqual(['zz', 'aa']);
    });

    it('should keep the order through a document write and a state write', async () => {
        const id = await createApp();
        const next: UiDocument = { app: { component: 'page', children: { y: { component: 'text' }, b: { component: 'text' } } } };

        await apps.writeDocument(id, next, 1);
        await apps.writeState(id, ['data'], { z: 1, a: 2 }, 2);
        const found = await apps.findById(id);

        expect(Object.keys((found?.document['app'] as { children: object }).children)).toEqual(['y', 'b']);
        expect(Object.keys(found?.stateSnapshot['data'] as object)).toEqual(['z', 'a']);
    });

    it('should start at revision 1 and raise it by one per document write but not per state write', async () => {
        const id = await createApp();

        const first = await apps.writeDocument(id, ORDERED, 1);
        const second = await apps.writeState(id, ['data', 'total'], 3, 2);

        expect(first).toEqual({ kind: 'written', revision: 2 });
        expect(second).toEqual({ kind: 'written', revision: 2 });
        expect((await apps.findById(id))?.revision).toBe(2);
    });

    it('should return a conflict with the current revision for a stale write and change nothing', async () => {
        const id = await createApp();
        await apps.writeDocument(id, ORDERED, 1);

        const stale = await apps.writeDocument(id, { app: { component: 'page' } }, 1);

        expect(stale).toEqual({ kind: 'conflict', currentRevision: 2 });
        expect((await apps.findById(id))?.document).toEqual(ORDERED);
    });

    it('should let only one of two racing writes with the same expected revision commit', async () => {
        const id = await createApp();

        const results = await Promise.all([apps.writeDocument(id, ORDERED, 1), apps.writeDocument(id, ORDERED, 1)]);

        expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'written']);
    });

    it('should start the state from the document data, keep state writes across a restart and refuse a stale one', async () => {
        // Arrange
        const id = await createApp();
        await apps.writeDocument(id, ORDERED, 1);

        // Act
        const written = await apps.writeState(id, ['app', 'children', 'a', 'open'], true, 2);
        const stale = await apps.writeState(id, ['data', 'typed'], 'old', 1);
        await authorities.close();
        authorities = createAuthorities();
        const found = await new FileUiAppRepository(folders, lock, authorities).findById(id);

        // Assert
        expect(written).toEqual({ kind: 'written', revision: 2 });
        expect(stale).toEqual({ kind: 'conflict', currentRevision: 2 });
        expect(found?.stateSnapshot).toEqual({ data: ORDERED['data'], app: { children: { a: { open: true } } } });
    });

    it('should carry a change of the document data into the running state and keep the rest of the state', async () => {
        // Arrange
        const id = await createApp();
        await apps.writeState(id, ['data', 'typed'], 'kept', 1);
        await apps.writeState(id, ['data', 'rows', 'aa', 'n'], 7, 1);
        const next: UiDocument = { ...ORDERED, data: { rows: { zz: { n: 5 } }, prices: { p1: 10 } } };

        // Act
        await apps.writeDocument(id, next, 1);
        const found = await apps.findById(id);

        // Assert
        expect(found?.stateSnapshot['data']).toEqual({ rows: { zz: { n: 5 } }, typed: 'kept', prices: { p1: 10 } });
    });

    it('should refuse a duplicate name', async () => {
        await createApp('same');

        expect(await apps.create({ name: 'same', document: ORDERED, sync: 'full' })).toEqual({ kind: 'duplicate-name' });
    });

    it('should list the apps newest first and skip folders that are not apps', async () => {
        const early = await createApp('early');
        await new Promise((resolve) => setTimeout(resolve, 5));
        const late = await createApp('late');
        await writeFile(join(dir, 'notes.txt'), 'x');

        const list = await apps.list();

        expect(list.map((app) => app.id)).toEqual([late, early]);
    });

    it('should delete only at the expected revision and remove the folder', async () => {
        const id = await createApp();

        expect(await apps.delete(id, 9)).toEqual({ kind: 'conflict', currentRevision: 1 });
        await apps.writeState(id, ['data', 'typed'], 'x', 1);
        expect(await apps.delete(id, 1)).toEqual({ kind: 'deleted' });
        await authorities.close();

        expect(await apps.findById(id)).toBeUndefined();
        expect(await apps.delete(id, 1)).toEqual({ kind: 'not-found' });
        expect(await readdir(dir)).toEqual([]);
    });

    it('should report a missing app and a malformed id as not found', async () => {
        expect(await apps.findById('nope')).toBeUndefined();
        expect(await apps.writeDocument('11111111-1111-4111-8111-111111111111', ORDERED, 1)).toEqual({ kind: 'not-found' });
    });
});

describe('FileUiErrorLog', () => {
    it('should keep the newest errors up to the cap, oldest first', async () => {
        const id = await createApp();
        const log = new FileUiErrorLog(folders, lock);

        for (let n = 0; n < MAX_PREVIEW_ERRORS + 5; n++) await log.append(id, { code: 'SUI-RUN-BINDING', message: `e${n}` });

        const kept = await log.list(id);
        expect(kept).toHaveLength(MAX_PREVIEW_ERRORS);
        expect(kept[0]?.message).toBe('e5');
        expect(kept.at(-1)?.message).toBe(`e${MAX_PREVIEW_ERRORS + 4}`);
    });

    it('should keep only the errors of the view load a view rendered from', async () => {
        // Arrange
        const id = await createApp();
        const log = new FileUiErrorLog(folders, lock);
        await log.append(id, { code: 'A', message: 'no source' });
        await log.append(id, { code: 'B', message: 'other view' }, { viewId: 'v2', load: 5 });
        await log.append(id, { code: 'C', message: 'first load' }, { viewId: 'v1', load: 1 });
        await log.append(id, { code: 'D', message: 'second load' }, { viewId: 'v1', load: 2 });

        // Act
        const kept = await log.keepFrom(id, { viewId: 'v1', load: 2 });

        // Assert
        expect(kept).toBe(true);
        expect((await log.list(id)).map((error) => error.code)).toEqual(['D']);
    });

    it('should read a log written before errors kept their source', async () => {
        const id = await createApp();
        await writeFileAtomic(folders.errorsFile(id), JSON.stringify([{ code: 'OLD', message: 'm' }]));
        const log = new FileUiErrorLog(folders, lock);

        expect(await log.list(id)).toEqual([{ code: 'OLD', message: 'm' }]);
        await log.keepFrom(id, { viewId: 'v1', load: 1 });
        expect(await log.list(id)).toEqual([]);
    });

    it('should not create a folder for an app that does not exist', async () => {
        const log = new FileUiErrorLog(folders, lock);

        expect(await log.append('11111111-1111-4111-8111-111111111111', { code: 'X', message: 'm' })).toBe(false);
        expect(await readdir(dir)).toEqual([]);
    });
});

describe('files', () => {
    async function* bytes(...chunks: number[][]): AsyncIterable<Uint8Array> {
        for (const chunk of chunks) yield Uint8Array.from(chunk);
    }

    it('should store the bytes, hash them and keep the first bytes as the head', async () => {
        const id = await createApp();
        const store = new FsUiFileStore(folders);
        const fileId = '22222222-2222-4222-8222-222222222222';

        const saved = await store.save(id, fileId, bytes([1, 2], [3]), 100);

        expect(saved.kind).toBe('saved');
        if (saved.kind === 'saved') {
            expect(saved.size).toBe(3);
            expect([...saved.head]).toEqual([1, 2, 3]);
            expect(saved.sha256).toHaveLength(64);
        }
        expect([...(await store.read(id, fileId))]).toEqual([1, 2, 3]);
    });

    it('should refuse more than the limit and leave no partial file', async () => {
        const id = await createApp();
        const store = new FsUiFileStore(folders);
        const fileId = '22222222-2222-4222-8222-222222222222';

        const saved = await store.save(id, fileId, bytes([1, 2, 3], [4, 5]), 4);

        expect(saved).toEqual({ kind: 'too-large' });
        expect(await store.open(id, fileId)).toBeUndefined();
        expect(await readdir(join(dir, id, 'files'))).toEqual([]);
    });

    it('should enforce the file count and add entries newest first', async () => {
        const id = await createApp();
        const files = new FileUiFileRepository(folders, lock);

        const added = await files.add({ id: '33333333-3333-4333-8333-333333333333', appId: id, name: 'a.txt', size: 3, type: 'text/plain', sha256: 'h' });

        expect(added.kind).toBe('added');
        expect(await files.usage(id)).toEqual({ count: 1, bytes: 3 });
        expect((await files.list(id)).map((file) => file.name)).toEqual(['a.txt']);
        expect(await files.add({ id: '44444444-4444-4444-8444-444444444444', appId: '11111111-1111-4111-8111-111111111111', name: 'x', size: 1, type: 'text/plain', sha256: 'h' })).toEqual({
            kind: 'not-found'
        });
    });

    it('should list the files uploaded before a time, referenced or not', async () => {
        const id = await createApp();
        const files = new FileUiFileRepository(folders, lock);
        const first = '55555555-5555-4555-8555-555555555555';
        const second = '66666666-6666-4666-8666-666666666666';
        await files.add({ id: first, appId: id, name: 'k', size: 1, type: 'text/plain', sha256: 'h' });
        await files.add({ id: second, appId: id, name: 'd', size: 1, type: 'text/plain', sha256: 'h' });

        const old = await files.findOlderThan(id, new Date(Date.now() + 60_000));
        const none = await files.findOlderThan(id, new Date(Date.now() - 60_000));

        expect(old.map((file) => file.id).sort()).toEqual([first, second]);
        expect(none).toEqual([]);
    });
});
