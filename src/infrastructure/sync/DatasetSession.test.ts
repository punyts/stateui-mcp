import { createAuthority, createMemoryNamespaceStorage, generateGrantKey, signGrant } from '@punyts/state-sync/authority';
import type { Access, Authority, GrantKey, GrantRight } from '@punyts/state-sync/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncNamespaceOf } from './DatasetNamespaces.js';
import { DatasetRequests } from './DatasetRequests.js';
import { DatasetSession } from './DatasetSession.js';

const OWNER = '00000000-0000-4000-8000-0000000000cc';
const ADDRESS = `${OWNER}/data/catalog`;
const KEY = generateGrantKey();
const KEYS = new Map<string, GrantKey>([['owner-1', { ownerId: OWNER, publicKey: KEY.publicKey }]]);

/** A grant on the catalog for a person, read and write by default, expiring at `expires` */
function grantUntil(expires: number, rights: GrantRight[] = ['read', 'write']): string {
    return signGrant({ kid: 'owner-1', issuer: OWNER, subject: 'person-1', owner: OWNER, pattern: '$.data.catalog', rights, issued: Date.now(), expires }, KEY.privateKey);
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

    it('should reconnect at once when a change is refused for access, so changed rights take effect', async () => {
        // Arrange: the first access only reads; the next may write
        const tokens = [grantUntil(Date.now() + 3_600_000, ['read']), grantUntil(Date.now() + 3_600_000)];
        const access = vi.fn(async (): Promise<Access> => ({ subject: 'person-1', grant: tokens.shift() ?? grantUntil(Date.now() + 3_600_000) }));
        const onRejected = vi.fn<(reason: string) => void>();
        session = open(access, onRejected);
        await session.ready(1_000);
        session.write([{ key: 'p1', value: { name: 'Lamp' } }]);
        const refused = await session.settled();

        // Act
        await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(2), { timeout: 3_000 });
        session.write([{ key: 'p1', value: { name: 'Lamp' } }]);
        const reason = await session.settled();

        // Assert
        expect(refused).toBeDefined();
        expect(onRejected).toHaveBeenCalledTimes(1);
        expect(reason).toBeUndefined();
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

describe('DatasetRequests', () => {
    it('should list a pending request to the owner with the records, and apply it on approval', async () => {
        // Arrange: a person who may only request suggests a record
        const grant = grantUntil(Date.now() + 3_600_000, ['read', 'request']);
        session = open(async () => ({ subject: 'person-1', grant }), () => undefined);
        await session.ready(1_000);
        session.write([{ key: 'p1', value: { name: 'Lamp' } }]);
        await session.settled();
        const requests = new DatasetRequests(() => ADDRESS, async (dataset) => dataset === 'catalog', async (_address, connection, as) => authority.connect(connection, as));

        // Act
        const listed = await requests.list('catalog', { subject: OWNER });
        const id = listed?.requests[0]?.id ?? '';
        const decided = await requests.decide('catalog', { subject: OWNER }, 'approve', id);
        const missing = await requests.list('other', { subject: OWNER });

        // Assert
        expect(listed?.records).toEqual({});
        expect(listed?.requests.map((request) => [request.path, request.value, request.by, request.status])).toEqual([['$.data.records.p1', { name: 'Lamp' }, 'person-1', 'pending']]);
        expect(decided?.status).toBe('approved');
        expect(authority.get('$.data.records.p1')).toEqual({ name: 'Lamp' });
        expect(missing).toBeUndefined();
        expect(await requests.decide('catalog', { subject: OWNER }, 'reject', 'no-such-request')).toBeUndefined();
    }, 15_000);
});
