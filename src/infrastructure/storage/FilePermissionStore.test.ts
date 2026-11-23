import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PERMISSION_DEPTH, PermissionRefused } from '../../application/permissions.js';
import { FilePermissionStore } from './FilePermissionStore.js';

describe('FilePermissionStore', () => {
    let dir: string;
    let clock: number;
    let store: FilePermissionStore;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stateui-permissions-'));
        clock = Date.parse('2026-11-22T10:00:00Z');
        store = new FilePermissionStore(dir, () => new Date(clock));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('should allow the owner everything, and anyone else only what a live entry for one of their subjects covers, with its right', async () => {
        // Arrange: owner 42 gives 7 the notes of app a1 for an hour, and every member of org 5 the app a2
        await store.make({ owner: '42', pattern: '$.apps.a1.data.notes', subject: 'owner:7', rights: ['read'], until: new Date(clock + 3_600_000).toISOString() });
        await store.make({ owner: '42', pattern: '$.apps.a2', subject: 'members:5', rights: ['read', 'write'] });

        // Act
        const answers = [
            await store.allows(['owner:7'], '42', '$.apps.a1.data.notes.n1', 'read'),
            await store.allows(['owner:7'], '42', '$.apps.a1.data', 'read'),
            await store.allows(['owner:7'], '42', '$.apps.a1.data.notes', 'write'),
            await store.allows(['owner:8', 'members:5'], '42', '$.apps.a2.files', 'write'),
            await store.allows(['owner:8'], '42', '$.apps.a2', 'read'),
            await store.allows(['owner:42'], '42', '$.anything', 'share')
        ];
        clock += 2 * 3_600_000;
        const ended = await store.allows(['owner:7'], '42', '$.apps.a1.data.notes', 'read');

        // Assert
        expect(answers).toEqual([true, false, false, true, false, true]);
        expect(ended).toBe(false);
    });

    it('should pass an entry on only narrower and at most eight long, cut to its end, and keep every entry in one file of the owner', async () => {
        // Arrange
        const root = await store.make({ owner: '42', pattern: '$.apps.a1', subject: 'owner:7', rights: ['read', 'share'], until: new Date(clock + 3_600_000).toISOString() });
        const refusal = (made: Promise<unknown>): Promise<string> => made.then(() => 'made', (error: unknown) => (error instanceof PermissionRefused ? error.reason : 'other'));

        // Act
        const passed = await store.make({ owner: '42', pattern: '$.apps.a1.files', subject: 'owner:9', rights: ['read'], parent: root.id });
        const refused = [
            await refusal(store.make({ owner: '42', pattern: '$.apps', subject: 'owner:9', rights: ['read'], parent: root.id })),
            await refusal(store.make({ owner: '42', pattern: '$.apps.a1', subject: 'owner:9', rights: ['write'], parent: root.id })),
            await refusal(store.make({ owner: '43', pattern: '$.apps.a1', subject: 'owner:9', rights: ['read'], parent: root.id })),
            await refusal(store.make({ owner: '42', pattern: '$.apps.a1', subject: 'owner:9', rights: ['read'], parent: 'missing' })),
            await refusal(store.make({ owner: '42', pattern: 'apps', subject: 'owner:9', rights: ['read'] }))
        ];
        let chain = passed;
        for (let depth = 2; depth < MAX_PERMISSION_DEPTH; depth++) chain = await store.make({ owner: '42', pattern: '$.apps.a1.files', subject: 'owner:9', rights: ['read'], parent: chain.id });
        const tooDeep = await refusal(store.make({ owner: '42', pattern: '$.apps.a1.files', subject: 'owner:9', rights: ['read'], parent: chain.id }));
        const file = JSON.parse(await readFile(join(dir, '42.json'), 'utf8')) as unknown[];

        // Assert
        expect(passed.until).toBe(root.until);
        expect(refused).toEqual(['wider', 'wider', 'not-found', 'not-found', 'invalid']);
        expect(tooDeep).toBe('too-deep');
        expect(file).toHaveLength(MAX_PERMISSION_DEPTH);
    });

    it('should revoke an entry with everything passed on from it, keep them, and name them as revoked', async () => {
        // Arrange
        const root = await store.make({ owner: '42', pattern: '$.apps.a1', subject: 'owner:7', rights: ['read'] });
        const passed = await store.make({ owner: '42', pattern: '$.apps.a1.files', subject: 'owner:9', rights: ['read'], parent: root.id });
        const other = await store.make({ owner: '42', pattern: '$.apps.a2', subject: 'owner:9', rights: ['read'] });

        // Act
        const revoked = await store.revoke('42', root.id, '42');
        const again = await store.revoke('42', root.id, '42');
        const named = await store.revoked('42', [root.id, passed.id, other.id]);
        const allowed = await store.allows(['owner:9'], '42', '$.apps.a1.files.f1', 'read');

        // Assert
        expect([...revoked].sort()).toEqual([root.id, passed.id].sort());
        expect(again).toEqual([]);
        expect([...named].sort()).toEqual([root.id, passed.id].sort());
        expect(allowed).toBe(false);
        expect((await store.list('42')).map((entry) => entry.revokedBy ?? '-')).toEqual(['42', '42', '-']);
    });
});
