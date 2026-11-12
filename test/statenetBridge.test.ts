import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startStatenet } from '@punyts/statenet';
import type { RunningStatenet } from '@punyts/statenet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from '../src/config/startServer.js';
import type { RunningServer } from '../src/config/startServer.js';
import { DIRECTORY_NAMESPACE, isRelayEnvelope, OPEN_EMIT, RelayAssembler, SERVER_EMIT, toEnvelopes, VIEW_EMIT } from '../src/domain/viewRelay.js';
import { call, createApp, noBrowser, silentReport, tempData } from './helpers.js';
import type { TempData } from './helpers.js';

/** The origin of the view page the statenet lets in; no page is served in this test */
const PAGE_ORIGIN = 'http://127.0.0.1:5999';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

type Message = Record<string, unknown>;

/** Waits for `check` to pass, up to five seconds */
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * A page as the statenet sees it: a sync client of a namespace with the page's Origin, speaking the protocol by hand
 * and the view relay over emits
 */
class FakePage {
    readonly viewId = randomUUID();
    readonly received: Message[] = [];
    /** The server's relay messages to this page, put back together */
    readonly fromServer: Message[] = [];
    private readonly assembler = new RelayAssembler();
    private socket: WebSocket | undefined;
    revision = 0;

    constructor(
        private readonly url: string,
        readonly namespace: string
    ) {}

    async open(): Promise<Message> {
        const socket = new WebSocket(this.url, { headers: { Origin: PAGE_ORIGIN } });
        this.socket = socket;
        socket.on('message', (data) => {
            const message = JSON.parse(String(data)) as Message;
            this.received.push(message);
            if (typeof message['revision'] === 'number') this.revision = Math.max(this.revision, message['revision']);
            if (message['type'] === 'changes') for (const change of message['changes'] as Message[]) this.revision = Math.max(this.revision, change['revision'] as number);
            if (message['type'] === 'emit' && message['name'] === SERVER_EMIT && isRelayEnvelope(message['value'])) {
                const envelope = message['value'];
                if (envelope.to !== undefined && envelope.to !== this.viewId) return;
                const assembled = this.assembler.add(envelope);
                if (assembled !== undefined) this.fromServer.push(assembled.message as Message);
            }
        });
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        this.send({ type: 'hello', namespace: this.namespace, revision: 0, clientId: this.viewId, protocol: 1 });
        return this.next((message) => message['type'] === 'welcome');
    }

    send(message: object): void {
        this.socket?.send(JSON.stringify(message));
    }

    /** Sends a relay message to the server */
    relay(message: object): void {
        for (const envelope of toEnvelopes(message, randomUUID(), { from: this.viewId })) this.send({ type: 'emit', name: VIEW_EMIT, value: envelope });
    }

    async next(match: (message: Message) => boolean): Promise<Message> {
        await eventually(() => this.received.some(match));
        return this.received.find(match) as Message;
    }

    async fromServerNext(match: (message: Message) => boolean): Promise<Message> {
        await eventually(() => this.fromServer.some(match));
        return this.fromServer.find(match) as Message;
    }

    close(): void {
        this.socket?.close();
    }
}

describe('the server and its views through a statenet', () => {
    let data: TempData;
    let statenet: RunningStatenet;
    let server: RunningServer;
    let client: Client;
    let appId: string;
    let namespace: string;
    const pages: FakePage[] = [];

    /** A page of the app, welcomed and said hello to the server, once the server answered with the app */
    async function openPage(): Promise<FakePage> {
        const page = new FakePage(statenet.url, namespace);
        pages.push(page);
        await page.open();
        page.relay({ type: 'hello', kind: 'browser' });
        await page.fromServerNext((message) => message['type'] === 'view');
        return page;
    }

    beforeAll(async () => {
        data = await tempData();
        statenet = await startStatenet({ dataDir: join(data.dir, 'statenet'), port: 0, allowedOrigins: [PAGE_ORIGIN] });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        server = await startServer({ dataDir: join(data.dir, 'mcp'), report: silentReport, statenetUrl: statenet.url, viewUrl: `${PAGE_ORIGIN}/`, transport: serverTransport, browser: noBrowser });
        client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(clientTransport);
        appId = (await createApp(client, 'shop')).id;
        const part = await server.services.instanceViews.find(appId);
        namespace = server.services.instanceViews.namespace(part!);
    });

    afterAll(async () => {
        for (const page of pages) page.close();
        await client?.close();
        await server?.stop();
        await statenet?.close();
        await data?.cleanup();
    });

    it('should list the apps in the directory namespace, with the namespace of each', async () => {
        const directory = new FakePage(statenet.url, DIRECTORY_NAMESPACE);
        pages.push(directory);

        await directory.open();
        // In the welcome when the server wrote it first, else in the changes that follow
        await eventually(() => JSON.stringify(directory.received).includes(namespace));

        expect(JSON.stringify(directory.received)).toContain('"name":"shop"');
        expect(server.viewOf(appId)).toBe(`${PAGE_ORIGIN}/?app=${appId}&statenet=${encodeURIComponent(statenet.url)}`);
    });

    it("should bridge an app a page asks for, and answer the page's hello with the app", async () => {
        // Arrange
        const directory = new FakePage(statenet.url, DIRECTORY_NAMESPACE);
        pages.push(directory);
        await directory.open();

        // Act
        directory.send({ type: 'emit', name: OPEN_EMIT, value: { appId } });
        await eventually(() => server.views.openApps().includes(appId));
        const page = await openPage();
        const attach = page.fromServer.find((message) => message['type'] === 'view')?.['message'] as Message;

        // Assert
        expect(attach).toMatchObject({ type: 'app', reason: 'attach', revision: 1 });
        expect(JSON.stringify(attach['document'])).toContain('"email"');
        expect(server.services.hub.viewCount(appId, 'browser')).toBeGreaterThanOrEqual(1);
    });

    it("should put the instance's state into the statenet and send a tool's write to the pages", async () => {
        const page = await openPage();

        const set = await call(client, 'ui_state_set', { app: 'shop', path: '$.screens.home.children.form.children.email.value', value: 'from the tool' });
        const pushed = await page.next(
            (message) => message['type'] === 'changes' && JSON.stringify(message['changes']).includes('from the tool')
        );

        expect(set.isError).toBe(false);
        expect(pushed['changes']).toEqual([expect.objectContaining({ path: '$.screens.home.children.form.children.email.value', value: 'from the tool' })]);
    });

    it("should give a page's change to the instance, where the tools read it", async () => {
        const page = await openPage();

        page.send({ type: 'change', change: { id: randomUUID(), path: '$.screens.home.children.form.children.email.value', op: 'set', value: 'typed in a page', base: page.revision } });
        await eventually(async () => JSON.stringify((await call(client, 'ui_state_get', { app: 'shop' })).body['state']).includes('typed in a page'));

        const state = await call(client, 'ui_state_get', { app: 'shop', path: '$.screens.home.children.form.children.email.value' });
        expect(state.body['value']).toBe('typed in a page');
    });

    it("should take a page's reports and app events, and forget a page that left", async () => {
        // Arrange
        const page = await openPage();
        const before = server.services.hub.viewCount(appId);

        // Act
        page.relay({ type: 'report', report: { type: 'ready', revision: 1, load: 1 } });
        page.relay({ type: 'event', name: 'form.saved', value: 'ok' });
        await eventually(async () => ((await call(client, 'ui_events_read', { app: 'shop' })).body['events'] as unknown[]).length > 0);
        const rendered = await server.services.hub.waitRendered(appId, 1, 'browser', 2000);
        page.close();
        await eventually(() => server.services.hub.viewCount(appId) === before - 1);

        // Assert
        const events = (await call(client, 'ui_events_read', { app: 'shop' })).body['events'] as Message[];
        expect(rendered).toBe(true);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'form.saved', payload: 'ok', view: 'browser' })]));
    });

    it('should send a definition change and a command to the open pages', async () => {
        const page = await openPage();

        const written = await call(client, 'ui_nodes_write', {
            app: 'shop',
            screen: 'home',
            expectedRevision: 1,
            operations: [{ op: 'add', path: 'root', key: 'note', value: { component: 'text', _text: 'A note from the agent' } }]
        });
        const document = await page.fromServerNext((message) => message['type'] === 'view' && JSON.stringify(message['message']).includes('A note from the agent'));
        const command = await call(client, 'ui_command', { app: 'shop', target: 'home', command: 'navigate' });
        const delivered = await page.fromServerNext((message) => message['type'] === 'view' && (message['message'] as Message)['type'] === 'command');

        expect(written.isError).toBe(false);
        expect((document['message'] as Message)['reason']).toBe('document');
        expect(command.body['previewAttached']).toBeDefined();
        expect(delivered['message']).toMatchObject({ type: 'command', target: 'home', command: 'navigate' });
    });

    it("should upload, read and release a page's files over the relay", async () => {
        // Arrange
        const page = await openPage();
        const request = async (message: Message): Promise<Message> => {
            const id = randomUUID();
            page.relay({ type: 'request', id, ...message });
            return page.fromServerNext((answer) => answer['type'] === 'response' && answer['id'] === id);
        };

        // Act
        const uploaded = await request({ method: 'POST', path: `/apps/${appId}/files`, name: 'dot.png', mediaType: 'image/png', body: PNG.toString('base64') });
        const fileId = (uploaded['json'] as Message)['id'] as string;
        const read = await request({ method: 'GET', path: `/apps/${appId}/files/${fileId}` });
        const released = await request({ method: 'DELETE', path: `/apps/${appId}/files/${fileId}` });
        const again = await request({ method: 'DELETE', path: `/apps/${appId}/files/${fileId}` });
        const otherApp = await request({ method: 'GET', path: `/apps/${randomUUID()}/files/${fileId}` });

        // Assert
        expect(uploaded).toMatchObject({ status: 201, json: { name: 'dot.png', size: PNG.length, type: 'image/png' } });
        expect(read['status']).toBe(200);
        expect(Buffer.from(read['bytes'] as string, 'base64').equals(PNG)).toBe(true);
        expect((read['headers'] as Message)['content-type']).toBe('image/png');
        expect([released['status'], again['status'], otherApp['status']]).toEqual([204, 404, 404]);
    });

    it('should tell the pages an app was deleted and stop bridging it', async () => {
        const page = await openPage();

        const deleted = await call(client, 'ui_delete', { kind: 'apps', name: 'shop', expectedRevision: 2 });
        const gone = await page.fromServerNext((message) => message['type'] === 'view' && (message['message'] as Message)['type'] === 'deleted');
        await eventually(() => !server.views.openApps().includes(appId));

        expect(deleted.isError).toBe(false);
        expect(gone).toBeDefined();
    });
});
