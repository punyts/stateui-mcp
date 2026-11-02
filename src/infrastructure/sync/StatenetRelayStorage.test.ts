import { randomBytes } from 'node:crypto';
import { startStatenet } from '@punyts/statenet';
import type { RunningStatenet } from '@punyts/statenet';
import { createAuthority } from '@punyts/state-sync/authority';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempData } from '../../../test/helpers.js';
import type { TempData } from '../../../test/helpers.js';
import { StatenetClient } from './statenetClient.js';
import { StatenetRelayStorage } from './StatenetRelayStorage.js';

const NAMESPACE = 'apps.relay';

async function eventually<T>(read: () => T, check: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = read();
        if (check(value)) return value;
        if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('StatenetRelayStorage', () => {
    let data: TempData;
    let statenet: RunningStatenet;
    const clients: StatenetClient[] = [];

    beforeEach(async () => {
        data = await tempData();
        statenet = await startStatenet({ port: 0, dataDir: data.dir });
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.stop();
        await statenet.close();
        await data.cleanup();
    });

    async function watch(): Promise<StatenetClient> {
        const client = new StatenetClient(statenet.url, NAMESPACE);
        clients.push(client);
        await client.ready();
        return client;
    }

    it('should load nothing from an empty namespace and relay the initial state, then each change once', async () => {
        // Arrange
        const storage = new StatenetRelayStorage(statenet.url, undefined);
        const authority = await createAuthority({ namespace: NAMESPACE, storage, initial: { data: { a: 1 }, app: {} }, createParents: true });
        const watcher = await watch();

        // Act
        authority.write({ path: '$.data.b', op: 'set', value: 2 });
        await authority.flush();
        authority.write({ path: '$.data.a', op: 'delete' });
        await authority.flush();
        const state = await eventually(() => watcher.current(), (current) => (current['data'] as Record<string, unknown> | undefined)?.['a'] === undefined && current['data'] !== undefined);
        authority.close();
        await storage.close();

        // Assert
        expect(state).toEqual({ data: { b: 2 }, app: {} });
    });

    it('should load what the statenet holds, with $.sealed back as $.server', async () => {
        // Arrange
        const key = new Uint8Array(randomBytes(32));
        const first = new StatenetRelayStorage(statenet.url, key);
        const writer = await createAuthority({ namespace: NAMESPACE, storage: first, initial: { data: {} }, serverKey: key, createParents: true });
        writer.write({ path: '$.server.token', op: 'set', value: 'abc' });
        writer.write({ path: '$.data.shown', op: 'set', value: true });
        await writer.flush();
        writer.close();
        await first.close();

        // Act
        const second = new StatenetRelayStorage(statenet.url, key);
        const reader = await createAuthority({ namespace: NAMESPACE, storage: second, serverKey: key, createParents: true });
        const watcher = await watch();

        // Assert
        expect(reader.state()).toEqual({ data: { shown: true }, server: { token: 'abc' } });
        expect(JSON.stringify(watcher.current())).not.toContain('abc');
        expect(Object.keys(watcher.current()).sort()).toEqual(['data', 'sealed']);
        reader.close();
        await second.close();
    });

    it('should not resend $.server when only its nonce changed', async () => {
        // Arrange
        const key = new Uint8Array(randomBytes(32));
        const storage = new StatenetRelayStorage(statenet.url, key);
        const authority = await createAuthority({ namespace: NAMESPACE, storage, initial: { data: {} }, serverKey: key, createParents: true });
        authority.write({ path: '$.server.token', op: 'set', value: 'abc' });
        await authority.flush();
        const watcher = await watch();
        const sealed = await eventually(() => watcher.current()['sealed'], (value) => value !== undefined);

        // Act
        authority.write({ path: '$.data.other', op: 'set', value: 1 });
        await authority.flush();
        await eventually(() => watcher.current(), (current) => (current['data'] as Record<string, unknown>)['other'] === 1);

        // Assert
        expect(watcher.current()['sealed']).toEqual(sealed);
        authority.close();
        await storage.close();
    });

    it('should fail a load when the statenet does not answer', async () => {
        // Arrange
        const storage = new StatenetRelayStorage('ws://127.0.0.1:1/sync', undefined);

        // Act / Assert
        await expect(storage.load(NAMESPACE)).rejects.toThrow('did not answer');
        await storage.close();
    }, 10_000);

    it('should refuse a save before a load', async () => {
        const storage = new StatenetRelayStorage(statenet.url, undefined);

        await expect(storage.save(NAMESPACE, { state: {}, revision: 1, log: [], applied: [] })).rejects.toThrow('saved before it was loaded');
    });
});
