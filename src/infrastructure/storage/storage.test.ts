import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PREVIEW_ERRORS } from '../../domain/limits.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { PartFolders } from './PartFolders.js';
import { writeFileAtomic } from './atomicFile.js';
import { FilePartRepository } from './FilePartRepository.js';
import { FileUiErrorLog } from './FileUiErrorLog.js';
import { FileUiFileRepository } from './FileUiFileRepository.js';
import { FsUiFileStore } from './FsUiFileStore.js';
import { KeyedLock } from './KeyedLock.js';

let dir: string;
let folders: PartFolders;
let lock: KeyedLock;
let parts: FilePartRepository;

const APP_BODY = Object.freeze({ shell: { component: 'page' }, start: 'home', screens: { home: { root: { component: 'panel' } } } }) as unknown as UiPartBodies['apps'];

/** Stores an app part and returns its id, which names the side folder of its files and errors */
async function createApp(name = 'one'): Promise<string> {
    const created = await parts.create({ kind: 'apps', name, body: APP_BODY });
    if (created.kind !== 'created') throw new Error('not created');
    return created.part.id;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-mcp-'));
    folders = new PartFolders(dir);
    lock = new KeyedLock();
    parts = new FilePartRepository(folders, lock);
});

afterEach(async () => {
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

    it('should delete one file unless the check says it is referenced, and run the check under the per-app lock', async () => {
        const id = await createApp();
        const files = new FileUiFileRepository(folders, lock);
        const kept = '77777777-7777-4777-8777-777777777777';
        const released = '88888888-8888-4888-8888-888888888888';
        await files.add({ id: kept, appId: id, name: 'k', size: 1, type: 'text/plain', sha256: 'h' });
        await files.add({ id: released, appId: id, name: 'r', size: 1, type: 'text/plain', sha256: 'h' });
        let addedDuringCheck: Promise<unknown> | undefined;
        let countSeenByCheck = -1;

        const referenced = await files.deleteUnlessReferenced(id, kept, async () => true);
        const deleted = await files.deleteUnlessReferenced(id, released, async () => {
            // An add asked for while the check runs waits for the release to finish
            addedDuringCheck = files.add({ id: '99999999-9999-4999-8999-999999999999', appId: id, name: 'n', size: 1, type: 'text/plain', sha256: 'h' });
            await new Promise((resolve) => setTimeout(resolve, 20));
            countSeenByCheck = (await files.usage(id)).count;
            return false;
        });
        await addedDuringCheck;
        const missing = await files.deleteUnlessReferenced(id, released, async () => {
            throw new Error('the check must not run for a missing file');
        });

        expect([referenced, deleted, missing]).toEqual(['referenced', 'deleted', 'not-found']);
        expect(countSeenByCheck).toBe(2);
        expect((await files.list(id)).map((file) => file.id).sort()).toEqual([kept, '99999999-9999-4999-8999-999999999999']);
    });
});
