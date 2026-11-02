import { randomBytes } from 'node:crypto';
import { startStatenet } from '@punyts/statenet';
import type { RunningStatenet } from '@punyts/statenet';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { StatenetClient } from '../src/infrastructure/sync/statenetClient.js';
import { call, FORM_DOCUMENT, httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const VIEW = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

/** Polls `read` until `check` passes, for values that arrive over a socket */
async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (check(value)) return value;
        if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/** A client that reads one namespace of the statenet directly */
async function inspect(statenet: RunningStatenet, appId: string): Promise<StatenetClient> {
    const client = new StatenetClient(statenet.url, `apps.${appId.toLowerCase()}`);
    await client.ready();
    return client;
}

/** A view's socket to the server: it answers with the frames it got, by type */
async function openView(origin: string, appId: string): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/apps/${appId}/sync?view=${VIEW}&kind=browser`, { headers: { Origin: origin } });
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return { socket, frames };
}

describe('stateui-mcp with a statenet', () => {
    let data: TempData;
    let statenetData: TempData;
    let statenet: RunningStatenet;
    let harness: HttpHarness | undefined;
    const inspectors: StatenetClient[] = [];

    beforeEach(async () => {
        data = await tempData();
        statenetData = await tempData();
        statenet = await startStatenet({ port: 0, dataDir: statenetData.dir });
    });

    afterEach(async () => {
        for (const inspector of inspectors.splice(0)) inspector.stop();
        await harness?.close();
        harness = undefined;
        await statenet.close();
        await data.cleanup();
        await statenetData.cleanup();
    });

    async function start(extra: { serverKey?: Uint8Array } = {}): Promise<HttpHarness> {
        harness = await httpHarness(data.dir, undefined, { statenet: statenet.url, ...extra });
        return harness;
    }

    async function createApp(running: HttpHarness, sync?: 'persisted'): Promise<string> {
        const created = await call(running.client, 'ui_app_create', {
            name: 'Relayed',
            document: { ...FORM_DOCUMENT, data: { greeting: 'hi' } },
            ...(sync !== undefined && { sync })
        });
        expect(created.isError).toBe(false);
        return created.body['appId'] as string;
    }

    async function watch(appId: string): Promise<StatenetClient> {
        const inspector = await inspect(statenet, appId);
        inspectors.push(inspector);
        return inspector;
    }

    it('should relay a change made in a view and a tool write to the statenet', async () => {
        // Arrange
        const running = await start();
        const appId = await createApp(running);
        const view = await openView(running.server.origin, appId);
        view.socket.send(JSON.stringify({ type: 'hello', namespace: `apps.${appId.toLowerCase()}`, revision: 0, clientId: VIEW, protocol: 1 }));
        await eventually(() => view.frames, (frames) => frames.some((frame) => frame['type'] === 'welcome' || frame['type'] === 'snapshot'));

        // Act
        view.socket.send(JSON.stringify({ type: 'change', change: { id: 'typed-1', path: '$.data.typed', op: 'set', value: 'x', base: 0 } }));
        await call(running.client, 'ui_state_set', { appId, path: '$.data.tool', value: 7 });
        const inspector = await watch(appId);
        const relayed = await eventually(
            () => inspector.current(),
            (state) => (state['data'] as Record<string, unknown> | undefined)?.['tool'] === 7
        );
        view.socket.close();

        // Assert
        expect(relayed['data']).toEqual({ greeting: 'hi', typed: 'x', tool: 7 });
        expect(relayed['app']).toEqual({});
    });

    it('should restore the state from the statenet when the server restarts', async () => {
        // Arrange
        const first = await start();
        const appId = await createApp(first);
        await call(first.client, 'ui_state_set', { appId, path: '$.data.kept', value: 'yes' });
        await first.close();
        harness = undefined;

        // Act
        const second = await start();
        const state = await call(second.client, 'ui_state_get', { appId });

        // Assert
        expect(state.isError).toBe(false);
        expect(state.body['state']).toMatchObject({ data: { greeting: 'hi', kept: 'yes' } });
    });

    it('should relay $.server sealed and restore it with the key', async () => {
        // Arrange
        const serverKey = new Uint8Array(randomBytes(32));
        const first = await start({ serverKey });
        const appId = await createApp(first);
        const document = { ...FORM_DOCUMENT };
        const authority = await first.server.services.authorities.authority(appId, document);
        authority.write({ path: '$.server.token', op: 'set', value: 'secret-token' });
        const inspector = await watch(appId);
        const relayed = await eventually(() => inspector.current(), (state) => state['sealed'] !== undefined);
        await first.close();
        harness = undefined;

        // Act
        const second = await start({ serverKey });
        const restored = (await second.server.services.authorities.authority(appId, document)).state();
        const read = await call(second.client, 'ui_state_get', { appId });

        // Assert
        expect(JSON.stringify(relayed)).not.toContain('secret-token');
        expect(restored['server']).toEqual({ token: 'secret-token' });
        expect(JSON.stringify(read.body)).not.toContain('secret-token');
    });

    it('should refuse an app whose state has $.server when the server has no key', async () => {
        // Arrange
        const serverKey = new Uint8Array(randomBytes(32));
        const first = await start({ serverKey });
        const appId = await createApp(first);
        (await first.server.services.authorities.authority(appId, { ...FORM_DOCUMENT })).write({ path: '$.server.token', op: 'set', value: 't' });
        const inspector = await watch(appId);
        await eventually(() => inspector.current(), (state) => state['sealed'] !== undefined);
        await first.close();
        harness = undefined;

        // Act
        const second = await start();
        const refused = second.server.services.authorities.authority(appId, { ...FORM_DOCUMENT });

        // Assert
        await expect(refused).rejects.toThrow('--secret-key-file or STATEUI_MCP_SECRET_KEY');
    });

    it('should keep a Persisted app in the statenet, seeded from the document, and refuse tool writes', async () => {
        // Arrange
        const running = await start();

        // Act
        const appId = await createApp(running, 'persisted');
        const inspector = await watch(appId);
        const seeded = await eventually(() => inspector.current(), (state) => state['data'] !== undefined);
        const write = await call(running.client, 'ui_state_set', { appId, path: '$.data.greeting', value: 'no' });
        inspector.send([{ id: 'from-a-page', path: '$.data.greeting', op: 'set', value: 'hello' }]);
        const read = await eventually(
            () => call(running.client, 'ui_state_get', { appId }),
            (result) => JSON.stringify(result.body['state']).includes('hello')
        );

        // Assert
        expect(seeded).toEqual({ data: { greeting: 'hi' }, app: {} });
        expect(write.isError).toBe(true);
        expect(write.body).toMatchObject({ error: 'persisted-app' });
        expect(read.body['state']).toEqual({ data: { greeting: 'hello' }, app: {} });
    });

    it('should point the page of a Persisted app at the statenet and send only view frames over its socket', async () => {
        // Arrange
        const running = await start();
        const appId = await createApp(running, 'persisted');

        // Act
        const page = await fetch(`${running.server.origin}/apps/${appId}`);
        const html = await page.text();
        const view = await openView(running.server.origin, appId);
        view.socket.send(JSON.stringify({ type: 'hello', namespace: `apps.${appId.toLowerCase()}`, revision: 0, clientId: VIEW, protocol: 1 }));
        await eventually(() => view.frames, (frames) => frames.length > 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
        view.socket.close();

        // Assert
        expect(html).toContain(`data-statenet-url="${statenet.url}"`);
        expect(page.headers.get('content-security-policy')).toContain(`connect-src 'self' ws://127.0.0.1:${statenet.port}`);
        expect(view.frames.map((frame) => frame['type'])).toEqual(['view']);
    });
});

describe('stateui-mcp without a statenet', () => {
    it('should refuse a Persisted app', async () => {
        // Arrange
        const data = await tempData();
        const running = await httpHarness(data.dir);

        try {
            // Act
            const created = await call(running.client, 'ui_app_create', { name: 'Nowhere', sync: 'persisted' });

            // Assert
            expect(created.isError).toBe(true);
            expect(created.body).toMatchObject({ error: 'no-statenet' });
        } finally {
            await running.close();
            await data.cleanup();
        }
    });
});
