import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { JsonValue, SyncState } from '@punyts/state-sync';
import type { Authority, AuthoritySession } from '@punyts/state-sync/authority';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';
import type { Services } from '../../config/createServices.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { MAX_FILE_BYTES } from '../../domain/UiFile.js';
import { DIRECTORY_NAMESPACE, fromBase64, isRelayEnvelope, OPEN_EMIT, RelayAssembler, SERVER_EMIT, toBase64, toEnvelopes, VIEW_EMIT } from '../../domain/viewRelay.js';
import type { DirectoryEntry } from '../../domain/viewRelay.js';
import type { ViewConnection, ViewMessage } from '../preview/PreviewHub.js';
import { takeViewReport } from '../preview/viewReports.js';
import { isAppId } from '../storage/PartFolders.js';
import { diffState, diffWrites, StatenetLink } from './StatenetLink.js';

/** The emit a statenet sends when a client of the namespace left (`@punyts/statenet`'s `LEFT_EMIT`) */
const LEFT_EMIT = 'statenet.left';
/** How long the bridge waits before it connects to an instance's authority again after it closed (a restart) */
const REATTACH_MS = 50;
/** The directory is written at most this often while parts change */
const DIRECTORY_DELAY_MS = 50;

type Dependencies = Pick<Services, 'useCases' | 'hub' | 'liveViews' | 'instanceViews' | 'onPartChange'>;

export interface StatenetViewsOptions {
    /** The statenet's WebSocket, such as `ws://127.0.0.1:4200/sync` */
    readonly url: string;
    readonly report: UseCaseReport;
}

/**
 * The server's side of the live views when they live in a statenet. The server holds no web server: it is a client of
 * the statenet, which the pages connect to.
 *
 * - The directory (`stateui.apps`): `$.apps.<appId>` names each app part and its instance's namespace; a page asks
 *   there for an app (`stateui.open`), and the server bridges it.
 * - One `AppBridge` per open app: it keeps the statenet's namespace equal to the instance's authority, and speaks the
 *   view relay with the pages.
 */
export class StatenetViews {
    private readonly directory: StatenetLink;
    private readonly bridges = new Map<string, AppBridge>();
    private directoryTimer: NodeJS.Timeout | undefined;
    private readonly unsubscribe: () => void;
    private closed = false;

    constructor(
        private readonly services: Dependencies,
        private readonly options: StatenetViewsOptions
    ) {
        this.directory = new StatenetLink(options.url, DIRECTORY_NAMESPACE, {
            onWelcome: () => {
                this.publishDirectory();
                // Pages that were waiting ask again for the apps they show
                for (const envelope of toEnvelopes({ type: 'ready' }, randomUUID())) this.directory.emit(SERVER_EMIT, envelope as unknown as JsonValue);
            },
            onEmit: (name, value) => {
                if (name === OPEN_EMIT && isJsonObject(value) && typeof value['appId'] === 'string') void this.open(value['appId']);
            },
            onStatus: (status) => {
                if (status === 'offline' && !this.closed) options.report.info('The statenet is not reachable; retrying', { url: options.url });
            }
        });
        this.unsubscribe = services.onPartChange((kind) => {
            if (kind === 'apps') this.scheduleDirectory();
        });
    }

    start(): void {
        this.directory.start();
    }

    /** The app ids with a bridge, for tests */
    openApps(): string[] {
        return [...this.bridges.keys()];
    }

    /** Bridges an app part's instance to the statenet (once); a page asks for it with `stateui.open` */
    async open(appId: string): Promise<void> {
        if (this.closed || !isAppId(appId)) return;
        const id = appId.toLowerCase();
        if (this.bridges.has(id)) return;
        const part = await this.services.instanceViews.find(id);
        if (part === undefined || this.bridges.has(id) || this.closed) return;
        const bridge = new AppBridge(id, this.services.instanceViews.namespace(part), this.services, this.options);
        this.bridges.set(id, bridge);
        bridge.start();
    }

    async close(): Promise<void> {
        this.closed = true;
        clearTimeout(this.directoryTimer);
        this.unsubscribe();
        for (const bridge of this.bridges.values()) bridge.stop();
        this.bridges.clear();
        this.directory.stop();
    }

    private scheduleDirectory(): void {
        if (this.directoryTimer !== undefined || this.closed) return;
        this.directoryTimer = setTimeout(() => {
            this.directoryTimer = undefined;
            this.publishDirectory();
        }, DIRECTORY_DELAY_MS);
    }

    /** Writes `$.apps` from the app parts, and stops the bridges of apps that are gone */
    private publishDirectory(): void {
        void (async () => {
            const apps = await this.services.instanceViews.list();
            const entries: Record<string, JsonValue> = {};
            for (const app of [...apps].sort((a, b) => a.id.localeCompare(b.id))) {
                const part = await this.services.instanceViews.find(app.id);
                if (part === undefined) continue;
                const entry: DirectoryEntry = { name: app.name, namespace: this.services.instanceViews.namespace(part), revision: app.revision, updatedAt: app.updatedAt.toISOString() };
                entries[app.id] = entry as unknown as JsonValue;
            }
            if (this.closed) return;
            this.directory.write(diffWrites(this.directory.state['apps'], entries, '$.apps'));
            for (const [id, bridge] of this.bridges) {
                if (entries[id] !== undefined) continue;
                bridge.stop();
                this.bridges.delete(id);
            }
        })().catch((error: unknown) => {
            this.options.report.info('The statenet directory was not written', { reason: error instanceof Error ? error.message : String(error) });
        });
    }
}

/**
 * Bridges one app's instance to its statenet namespace, both ways:
 *
 * - The instance's authority (in this process: logic, guards, shared datasets, storage) is the truth. Every change it
 *   pushes (logic, a tool, another instance's dataset write) is written to the statenet; on every (re)connect the
 *   statenet's state is made equal to the authority's.
 * - A change a page made reaches the bridge from the statenet and goes to the authority as a client change. When the
 *   authority adjusts or refuses it, the statenet gets the authority's value back and the pages a `rejected` message.
 * - The view relay: a page's `hello` attaches it to the hub (the attach message goes back to it), its reports, app
 *   events and file requests are answered, and `statenet.left` or `bye` detaches it.
 */
class AppBridge {
    private readonly link: StatenetLink;
    private readonly assembler = new RelayAssembler();
    private readonly views = new Map<string, () => void>();
    /** Changes sent to the authority and not yet acknowledged, by id: their paths */
    private readonly pending = new Map<string, string>();
    private authority: Authority | undefined;
    private session: AuthoritySession | undefined;
    /** The authority's revision as this bridge last heard */
    private revision = 0;
    private stopped = false;

    constructor(
        private readonly appId: string,
        namespace: string,
        private readonly services: Dependencies,
        private readonly options: StatenetViewsOptions
    ) {
        this.link = new StatenetLink(options.url, namespace, {
            onWelcome: () => {
                this.reconcile();
                this.broadcast({ type: 'ready' });
            },
            onRemote: (path, value) => this.toAuthority(path, value),
            onEmit: (name, value) => this.onEmit(name, value)
        });
    }

    start(): void {
        this.link.start();
        void this.attach();
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        for (const detach of this.views.values()) detach();
        this.views.clear();
        const session = this.session;
        this.session = undefined;
        session?.close();
        this.link.stop();
    }

    /** Connects to the instance's authority (again, after a restart over a changed definition) */
    private async attach(): Promise<void> {
        if (this.stopped) return;
        const part = await this.services.instanceViews.find(this.appId);
        if (part === undefined || this.stopped) return;
        let authority: Authority;
        try {
            authority = await this.services.instanceViews.authority(part);
        } catch (error) {
            this.options.report.info('The instance did not start for the statenet', { app: this.appId, reason: error instanceof Error ? error.message : String(error) });
            return;
        }
        if (this.stopped) return;
        this.authority = authority;
        let session: AuthoritySession | undefined;
        session = authority.connect({
            send: (text) => this.fromAuthority(text),
            close: () => {
                if (this.session !== session) return;
                this.session = undefined;
                this.authority = undefined;
                this.pending.clear();
                setTimeout(() => void this.attach(), REATTACH_MS);
            }
        });
        this.session = session;
        session.receive(JSON.stringify({ type: 'hello', namespace: this.link.namespace, revision: 0, clientId: `statenet-bridge-${randomUUID()}`, protocol: 1 }));
        this.reconcile();
    }

    /** Makes the statenet's state the authority's (without `$.server`, which never leaves it) */
    private reconcile(): void {
        if (this.authority === undefined || !this.link.isOnline) return;
        const { server: _server, ...truth } = this.authority.state() as SyncState;
        this.link.write(diffState(this.link.state, truth));
    }

    private fromAuthority(text: string): void {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(text) as Record<string, unknown>;
        } catch {
            return;
        }
        switch (message['type']) {
            case 'welcome':
                if (typeof message['revision'] === 'number') this.revision = message['revision'];
                return;
            case 'changes': {
                const changes = Array.isArray(message['changes']) ? (message['changes'] as Record<string, unknown>[]) : [];
                this.link.write(
                    changes.map((change) => {
                        if (typeof change['revision'] === 'number') this.revision = change['revision'];
                        const op = change['op'] === 'replace' || change['op'] === 'merge' ? change['op'] : 'set';
                        return change['op'] === 'delete' ? { path: String(change['path']) } : { path: String(change['path']), op, value: change['value'] as JsonValue };
                    })
                );
                return;
            }
            case 'ack': {
                if (typeof message['revision'] === 'number') this.revision = Math.max(this.revision, message['revision']);
                const id = String(message['id']);
                const path = this.pending.get(id);
                this.pending.delete(id);
                if (path === undefined || message['result'] === 'applied') return;
                // The statenet applied the page's change first: it gets the authority's value back
                const value = this.authority?.get(path);
                this.link.write([value === undefined ? { path } : { path, value }]);
                if (message['result'] === 'rejected') this.broadcast({ type: 'view', message: { type: 'rejected', path, reason: typeof message['reason'] === 'string' ? message['reason'] : 'Refused' } });
                return;
            }
            default:
                return;
        }
    }

    /** A page's change, from the statenet, to the authority as a client change */
    private toAuthority(path: string, value: JsonValue | undefined): void {
        if (this.session === undefined) return;
        const id = randomUUID();
        this.pending.set(id, path);
        const change = value === undefined ? { id, path, op: 'delete', base: this.revision } : { id, path, op: 'set', value, base: this.revision };
        this.session.receive(JSON.stringify({ type: 'change', change }));
    }

    private onEmit(name: string, value: JsonValue | undefined): void {
        if (name === LEFT_EMIT) {
            if (isJsonObject(value) && typeof value['clientId'] === 'string') this.detach(value['clientId']);
            return;
        }
        if (name !== VIEW_EMIT || !isRelayEnvelope(value) || value.from === undefined || !isAppId(value.from)) return;
        const assembled = this.assembler.add(value);
        if (assembled === undefined || !isJsonObject(assembled.message as JsonValue)) return;
        void this.onViewMessage(value.from, assembled.message as Record<string, JsonValue>).catch((error: unknown) => {
            this.options.report.info('A view message failed', { app: this.appId, reason: error instanceof Error ? error.message : String(error) });
        });
    }

    private async onViewMessage(viewId: string, message: Record<string, JsonValue>): Promise<void> {
        const { hub, liveViews } = this.services;
        if (message['type'] !== 'hello') hub.touch(this.appId, viewId);
        switch (message['type']) {
            case 'hello': {
                const first = await liveViews.attachMessage(this.appId);
                if (first === undefined || this.stopped) return;
                // A view says hello again when the server or the statenet came back: it keeps what it reported
                if (!this.views.has(viewId)) {
                    const connection: ViewConnection = { id: viewId, kind: message['kind'] === 'headless' ? 'headless' : 'browser', send: (view: ViewMessage) => this.send(viewId, { type: 'view', message: view }) };
                    this.views.set(viewId, hub.attach(this.appId, connection));
                }
                this.send(viewId, { type: 'view', message: first });
                return;
            }
            case 'bye':
                this.detach(viewId);
                return;
            case 'report':
                if (isJsonObject(message['report'])) await takeViewReport(this.services, this.appId, { ...message['report'], viewId });
                return;
            case 'event':
                if (typeof message['name'] === 'string') hub.recordEvent(this.appId, viewId, message['name'], message['value']);
                return;
            case 'request':
                if (typeof message['id'] === 'string') this.send(viewId, { type: 'response', id: message['id'], ...(await this.fileRequest(message)) });
                return;
            default:
                return;
        }
    }

    private detach(viewId: string): void {
        this.views.get(viewId)?.();
        this.views.delete(viewId);
    }

    /** The file routes of the page, over the relay: upload, download and release, answered as the HTTP routes answer */
    private async fileRequest(message: Record<string, JsonValue>): Promise<{ status: number; json?: JsonValue; bytes?: string; headers?: Record<string, string> }> {
        const { useCases } = this.services;
        const parts = String(message['path'] ?? '').split('/').filter((part) => part !== '');
        if (parts[0] !== 'apps' || parts[1]?.toLowerCase() !== this.appId || parts[2] !== 'files' || parts.length > 4) return { status: 404 };
        const fileId = parts[3];
        if (message['method'] === 'POST' && fileId === undefined) {
            const body = message['body'];
            if (typeof body !== 'string' || body.length > Math.ceil((MAX_FILE_BYTES + 3) / 3) * 4 + 4) return { status: 413 };
            const result = await useCases.uploadFile.execute(this.appId, { name: typeof message['name'] === 'string' ? message['name'] : 'file', content: Readable.from([fromBase64(body)]) });
            switch (result.kind) {
                case 'uploaded':
                    return { status: 201, json: { id: result.file.id, name: result.file.name, size: result.file.size, type: result.file.type } };
                case 'not-found':
                    return { status: 404 };
                case 'too-large':
                    return { status: 413 };
                case 'empty':
                case 'unsupported-type':
                    return { status: 415 };
                case 'quota':
                    return { status: 409, json: { error: 'quota', reason: result.reason } };
            }
        }
        if (fileId === undefined || !isAppId(fileId)) return { status: 400 };
        if (message['method'] === 'GET') {
            const result = await useCases.readFile.execute(this.appId, fileId);
            if (result.kind === 'not-found') return { status: 404 };
            const chunks: Buffer[] = [];
            for await (const chunk of result.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
            const encoded = encodeURIComponent(result.file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
            return {
                status: 200,
                bytes: toBase64(Buffer.concat(chunks)),
                headers: { 'content-type': result.file.type, 'content-disposition': `attachment; filename*=UTF-8''${encoded}` }
            };
        }
        if (message['method'] === 'DELETE') {
            const result = await useCases.releaseFile.execute(this.appId, fileId);
            return { status: result.kind === 'released' ? 204 : result.kind === 'referenced' ? 409 : 404 };
        }
        return { status: 404 };
    }

    private send(to: string, message: unknown): void {
        for (const envelope of toEnvelopes(message, randomUUID(), { to })) this.link.emit(SERVER_EMIT, envelope as unknown as JsonValue);
    }

    private broadcast(message: unknown): void {
        for (const envelope of toEnvelopes(message, randomUUID())) this.link.emit(SERVER_EMIT, envelope as unknown as JsonValue);
    }
}
