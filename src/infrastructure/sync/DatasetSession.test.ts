import { createAuthority, createMemoryNamespaceStorage, generateGrantKey, signGrant } from '@punyts/state-sync/authority';
import type { Access, Authority, GrantKey } from '@punyts/state-sync/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncNamespaceOf } from './DatasetNamespaces.js';
import { DatasetSession } from './DatasetSession.js';

const OWNER = '00000000-0000-4000-8000-0000000000cc';
const ADDRESS = `${OWNER}/data/catalog`;
const KEY = generateGrantKey();
const KEYS = new Map<string, GrantKey>([['owner-1', { ownerId: OWNER, publicKey: KEY.publicKey }]]);

/** A read and write grant on the catalog for a person, expiring at `expires` */
function grantUntil(expires: number): string {
    return signGrant(
        { kid: 'owner-1', issuer: OWNER, subject: 'person-1', owner: OWNER, pattern: '$.data.catalog', rights: ['read', 'write'], issued: Date.now(), expires },
        KEY.privateKey
    );
}

let authority: Authority;
let session: DatasetSession | undefined;

beforeEach(async () => {
    authority = await createAuthority({
        namespace: syncNamespaceOf(ADDRESS),
        storage: createMemoryNamespaceStorage(),
        createParents: true,
        access: { address: ADDRESS, context: () => ({ keyOf: (kid) => KEYS.get(kid), now: Date.now() }) }
    });
});

afterEach(() => {
    session?.close();
    session = undefined;
});

function open(access: () => Promise<Access | undefined>, onRejected: (reason: string) => void): DatasetSession {
    return new DatasetSession({
        address: ADDRESS,
        access,
        connect: async (_address, connection, as) => authority.connect(connection, as),
        renewBeforeMs: 1_000,
        onRecords: () => undefined,
        onRequests: () => undefined,
        onRejected
    });
}

describe('DatasetSession', () => {
    it('should reconnect with a fresh access before its grant expires, so a later write is applied', async () => {
        // Arrange
        const firstExpires = Date.now() + 2_000;
        const tokens = [grantUntil(firstExpires), grantUntil(Date.now() + 3_600_000)];
        const access = vi.fn(async (): Promise<Access> => ({ subject: 'person-1', grant: tokens.shift() ?? grantUntil(Date.now() + 3_600_000) }));
        const onRejected = vi.fn<(reason: string) => void>();
        session = open(access, onRejected);
        await session.ready(1_000);

        // Act
        await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(2), { timeout: 3_000 });
        await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(firstExpires), { timeout: 3_000 });
        session.write([{ key: 'p1', value: { name: 'Lamp' } }]);
        const reason = await session.settled();

        // Assert
        expect(reason).toBeUndefined();
        expect(onRejected).not.toHaveBeenCalled();
        expect(authority.get('$.data.records.p1')).toEqual({ name: 'Lamp' });
    }, 10_000);

    it('should keep its connection when the access has no grant', async () => {
        // Arrange
        const access = vi.fn(async (): Promise<Access> => ({ subject: OWNER }));
        session = open(access, () => undefined);
        await session.ready(1_000);

        // Act
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        session.write([{ key: 'p1', value: { name: 'Lamp' } }]);
        const reason = await session.settled();

        // Assert
        expect(access).toHaveBeenCalledTimes(1);
        expect(reason).toBeUndefined();
        expect(authority.get('$.data.records.p1')).toEqual({ name: 'Lamp' });
    }, 10_000);
});
