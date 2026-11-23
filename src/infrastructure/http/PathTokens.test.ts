import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGrant } from '@punyts/state-sync/authority';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePermissionStore } from '../storage/FilePermissionStore.js';
import { MemoryGrantKeys, PATH_TOKEN_LIFE_MS, PathTokens } from './PathTokens.js';

const APP = '5f0c2b8e-1d4a-4c3b-9e2f-0a1b2c3d4e5f';
const OTHER_APP = '0b6e8c1a-3f1e-4a52-9a43-2f4f1c8f2d10';
const FILE = `$.apps.${APP}.files.7d1e5c3a-9b2f-4e6d-8a0c-1f2e3d4c5b6a`;

describe('PathTokens', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stateui-path-tokens-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("should let a token read the files of its app of its owner until it expires, and nothing else", async () => {
        // Arrange
        let now = 1_000_000;
        const tokens = new PathTokens(new MemoryGrantKeys(), () => now);
        const token = await tokens.issue('42', APP.toUpperCase());

        // Act
        const fresh = await tokens.allows(token, '42', FILE);
        const otherApp = await tokens.allows(token, '42', `$.apps.${OTHER_APP}.files.x`);
        const otherOwner = await tokens.allows(token, '43', FILE);
        const appItself = await tokens.allows(token, '42', `$.apps.${APP}`);
        now += PATH_TOKEN_LIFE_MS;
        const expired = await tokens.allows(token, '42', FILE);

        // Assert
        expect(readGrant(token)).toMatchObject({ issuer: '42', subject: '42', owner: '42', pattern: `$.apps.${APP}.files`, rights: ['read'] });
        expect([fresh, otherApp, otherOwner, appItself, expired]).toEqual([true, false, false, false, false]);
    });

    it("should name the reader and their entry, and refuse the token once the entry or one above it is revoked", async () => {
        // Arrange: owner 42 gives 7 its app, and 7 passes it on to 9
        const store = new FilePermissionStore(dir);
        const tokens = new PathTokens(new MemoryGrantKeys(store));
        const given = await store.make({ owner: '42', pattern: `$.apps.${APP}`, subject: 'owner:7', rights: ['read', 'share'] });
        const passed = await store.make({ owner: '42', pattern: `$.apps.${APP}.files`, subject: 'owner:9', rights: ['read'], parent: given.id });
        const token = await tokens.issue('42', APP, { subject: '9', entry: passed.id });

        // Act
        const before = await tokens.allows(token, '42', FILE);
        await store.revoke('42', given.id, '42');
        const after = await tokens.allows(token, '42', FILE);

        // Assert
        expect(readGrant(token)).toMatchObject({ subject: '9', entry: passed.id });
        expect([before, after]).toEqual([true, false]);
    });

    it("should refuse a token signed by another server's keys, altered, or too long", async () => {
        // Arrange
        const tokens = new PathTokens(new MemoryGrantKeys());
        const token = await tokens.issue('42', APP);
        const [body, signature] = token.split('.') as [string, string];
        const widened = Buffer.from(JSON.stringify({ ...readGrant(token), pattern: '$' })).toString('base64url');

        // Act
        const elsewhere = await new PathTokens(new MemoryGrantKeys()).allows(token, '42', FILE);
        const altered = await tokens.allows(`${widened}.${signature}`, '42', `$.data.x`);
        const unsigned = await tokens.allows(body, '42', FILE);
        const long = await tokens.allows(`${body}.${signature}${'A'.repeat(4096)}`, '42', FILE);

        // Assert
        expect([elsewhere, altered, unsigned, long]).toEqual([false, false, false, false]);
    });
});
