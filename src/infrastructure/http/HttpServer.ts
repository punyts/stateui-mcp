import busboy from 'busboy';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UiAppRepository } from '../../application/ports/UiAppRepository.js';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';
import type { UploadFileResult } from '../../application/use-cases/UploadFile.js';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { MAX_FILE_BYTES } from '../../domain/UiFile.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { isAppId } from '../storage/PartFolders.js';
import type { InstanceViews } from '../preview/InstanceViews.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { Authority } from '@punyts/state-sync/authority';
import type { AppAuthorities } from '../sync/AppAuthorities.js';
import type { PreviewHub, ViewConnection, ViewMessage } from '../preview/PreviewHub.js';
import { appPage, indexPage, PAGE_CSS } from './pages.js';
import type { RuntimeBundle } from './runtimeBundle.js';
import { RUNTIME_CSS, runtimePage } from './runtimeBundle.js';
import { COMMON_HEADERS, FILE_CSP, hostPageCsp, isAllowedHost, isSameOrigin, LIST_PAGE_CSP, requestHostName, runtimeCsp } from './security.js';

/** The MCP side of `/mcp`: sessions of the streamable HTTP transport */
export interface McpEndpoint {
    handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void>;
    close(): Promise<void>;
}

export interface HttpServerOptions {
    readonly host: string;
    readonly port: number;
    /** The port of the runtime origin, which serves only the runtime page, bundle and stylesheet. 0 picks a free port */
    readonly runtimePort: number;
    readonly useCases: UiBuilderUseCases;
    readonly repository: UiAppRepository;
    readonly hub: PreviewHub;
    /** The sync authority of each app, which the views' sockets connect to */
    readonly authorities: AppAuthorities;
    /** The statenet's WebSocket URL, which the views of Persisted apps connect to */
    readonly statenet?: string;
    readonly liveViews: LiveViews;
    /** The views of the owner's apps (parts): an app id that is not an app document's is looked up here */
    readonly instances?: InstanceViews;
    readonly mcp: McpEndpoint;
    readonly runtime: RuntimeBundle;
    /** The compiled host script, served as `/assets/host.js` */
    readonly hostScript: Buffer;
    readonly report: UseCaseReport;
}

export interface RunningHttpServer {
    /** The origin the server listens on, such as `http://127.0.0.1:4100`. Known after `listen`, so a port of 0 works */
    readonly origin: string;
    readonly port: number;
    /** The port of the runtime origin */
    readonly runtimePort: number;
    close(): Promise<void>;
}

const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BODY_BYTES = 2 * 1024 * 1024;
const KEEP_ALIVE_MS = 15_000;
/** A sync message is at most 1,000,000 characters (`parseMessage`); a frame may hold that many bytes of UTF-8 twice over */
const MAX_SYNC_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_REPORTED_ERRORS = 50;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly code: string = 'bad_request'
    ) {
        super(message);
    }
}

function send(response: ServerResponse, status: number, contentType: string, body: string | Buffer, headers: Record<string, string> = {}): void {
    response.writeHead(status, { 'Content-Type': contentType, ...COMMON_HEADERS, ...headers });
    response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: object): void {
    send(response, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
}

function sendError(response: ServerResponse, error: HttpError): void {
    sendJson(response, error.status, { error: error.code, message: error.message });
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > limit) throw new HttpError(413, `The body is over ${limit} bytes`, 'too_large');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
    const buffer = await readBody(request, limit);
    if (buffer.length === 0) return undefined;
    try {
        return JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
        throw new HttpError(400, 'The body is not valid JSON');
    }
}

function isUuid(value: string | null): value is string {
    return value !== null && isAppId(value);
}

function toBuildErrors(value: unknown): UiBuildError[] {
    if (!Array.isArray(value)) return [];
    const errors: UiBuildError[] = [];
    for (const item of value.slice(-MAX_REPORTED_ERRORS)) {
        if (!isJsonObject(item) || typeof item['code'] !== 'string' || typeof item['message'] !== 'string') continue;
        const severity = item['severity'];
        errors.push({
            code: item['code'].slice(0, 64),
            message: item['message'].slice(0, 2000),
            ...((severity === 'error' || severity === 'warning') && { severity }),
            ...(typeof item['statePath'] === 'string' && { statePath: item['statePath'].slice(0, 500) }),
            ...(typeof item['component'] === 'string' && { component: item['component'].slice(0, 100) })
        });
    }
    return errors;
}

/**
 * The one HTTP server: `POST/GET/DELETE /mcp` for MCP clients and the browser endpoint for people and for Playwright.
 *
 * | Route | What |
 * |---|---|
 * | `GET /` | the apps, with a link to each |
 * | `GET /apps/:appId` | the live view of an app: an app document, or an owner app (a part) assembled, with the default persona's instance |
 * | `GET /apps/:appId/sync?view=<uuid>&kind=browser\|headless` | the WebSocket of a view: the state-sync protocol with the app's authority, and `{ type: 'view', message }` frames for the document, commands, locale, theme and deletion |
 * | `POST /apps/:appId/report` | what a view tells the server: ready, rendered, errors |
 * | `POST /apps/:appId/files` | an upload from a `fileField` (multipart, one field `file`) |
 * | `GET /apps/:appId/files/:fileId` | the bytes of an upload, as an attachment |
 * | `GET /assets/host.js`, `/assets/page.css` | the host script and the stylesheet |
 *
 * A second listener on `runtimePort` is the runtime origin. It serves only the app frame:
 *
 * | Route | What |
 * |---|---|
 * | `GET /runtime/<hash>.html`, `/runtime/<hash>.js`, `/runtime/runtime.css` | the content-hashed StateUI runtime page and bundle, and the page's stylesheet |
 *
 * The frame is sandboxed with `allow-scripts allow-same-origin`. Its own origin keeps it apart from the host page, and
 * browsers that refuse a frame with an opaque origin (some embedded browsers) still show it
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
    const { useCases, repository, hub, authorities, liveViews, runtime, report } = options;
    const runtimePageBuffer = Buffer.from(runtimePage(runtime.hash), 'utf8');
    const runtimeBase = '/runtime';
    // Both known after listen, so a port of 0 works
    let mainPort = 0;
    let runtimePort = 0;

    /** The host name the request used, so the other origin is reached by the same name */
    function hostNameOf(request: IncomingMessage): string {
        const name = requestHostName(request.headers.host);
        if (name === undefined) throw new HttpError(400, 'The Host header is not a host name', 'bad_host');
        return name;
    }

    async function runtimeRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (request.method === 'GET' && path === `${runtimeBase}/${runtime.hash}.html`) {
            const csp = runtimeCsp(`http://${hostNameOf(request)}:${mainPort}`);
            send(response, 200, 'text/html; charset=utf-8', runtimePageBuffer, { 'Content-Security-Policy': csp, 'Cache-Control': 'no-cache' });
            return;
        }
        if (request.method === 'GET' && path === `${runtimeBase}/runtime.css`) {
            send(response, 200, 'text/css; charset=utf-8', RUNTIME_CSS, { 'Cache-Control': 'no-cache' });
            return;
        }
        if (request.method === 'GET' && path === `${runtimeBase}/${runtime.hash}.js`) {
            send(response, 200, 'text/javascript; charset=utf-8', runtime.script, { 'Cache-Control': 'public, max-age=31536000, immutable' });
            return;
        }
        throw new HttpError(404, 'Not found', 'not_found');
    }

    async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = request.method ?? 'GET';

        if (path === '/mcp') {
            const body = method === 'POST' ? await readJsonBody(request, MAX_JSON_BODY_BYTES) : undefined;
            await options.mcp.handle(request, response, body);
            return;
        }
        if (method === 'GET' && path === '/') {
            send(response, 200, 'text/html; charset=utf-8', indexPage(await repository.list()), { 'Content-Security-Policy': LIST_PAGE_CSP, 'Cache-Control': 'no-store' });
            return;
        }
        if (method === 'GET' && path === '/assets/host.js') {
            send(response, 200, 'text/javascript; charset=utf-8', options.hostScript, { 'Cache-Control': 'no-cache' });
            return;
        }
        if (method === 'GET' && path === '/assets/page.css') {
            send(response, 200, 'text/css; charset=utf-8', PAGE_CSS, { 'Cache-Control': 'no-cache' });
            return;
        }

        const parts = path.split('/').filter((part) => part !== '');
        if (parts[0] === 'apps' && parts[1] !== undefined && SEGMENT.test(parts[1])) {
            const appId = parts[1];
            if (!isAppId(appId)) throw new HttpError(400, 'An app id is a UUID', 'invalid_id');
            const rest = parts.slice(2);
            if (method === 'GET' && rest.length === 0) return appRoute(request, response, appId);
            if (method === 'POST' && rest.length === 1 && rest[0] === 'report') return reportRoute(request, response, appId);
            if (method === 'POST' && rest.length === 1 && rest[0] === 'files') return uploadRoute(request, response, appId);
            if (method === 'GET' && rest.length === 2 && rest[0] === 'files' && rest[1] !== undefined) return downloadRoute(response, appId, rest[1]);
        }
        throw new HttpError(404, 'Not found', 'not_found');
    }

    async function appRoute(request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const app = await repository.findById(appId);
        const part = app === undefined ? await options.instances?.find(appId) : undefined;
        if (app === undefined && part === undefined) throw new HttpError(404, 'No app with this id', 'not_found');
        const headless = /HeadlessChrome/.test(request.headers['user-agent'] ?? '');
        const persistedUrl = app?.sync === 'persisted' ? options.statenet : undefined;
        const runtimeOrigin = `http://${hostNameOf(request)}:${runtimePort}`;
        const namespace = part === undefined ? undefined : options.instances?.namespace(part);
        send(
            response,
            200,
            'text/html; charset=utf-8',
            appPage({
                appId,
                name: app?.name ?? part?.name ?? '',
                runtimeUrl: `${runtimeOrigin}${runtimeBase}/${runtime.hash}.html`,
                viewKind: headless ? 'headless' : 'browser',
                ...(persistedUrl !== undefined && { statenetUrl: persistedUrl }),
                ...(namespace !== undefined && { namespace })
            }),
            { 'Content-Security-Policy': hostPageCsp(runtimeOrigin, persistedUrl), 'Cache-Control': 'no-store' }
        );
    }

    async function reportRoute(request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const body = await readJsonBody(request, MAX_REPORT_BODY_BYTES);
        if (!isJsonObject(body) || !isUuid(typeof body['viewId'] === 'string' ? body['viewId'] : null)) {
            throw new HttpError(400, 'A report is a JSON object with a viewId', 'invalid_report');
        }
        const viewId = body['viewId'] as string;
        const revision = typeof body['revision'] === 'number' ? body['revision'] : undefined;
        // The load the view counts: a ready or rendered report drops the errors earlier loads left
        const source = Number.isSafeInteger(body['load']) ? { viewId, load: body['load'] as number } : undefined;
        switch (body['type']) {
            case 'ready':
            case 'rendered':
                hub.touch(appId, viewId, { ...(body['type'] === 'ready' && { ready: true }), ...(revision !== undefined && { revision }) });
                if (source !== undefined) await useCases.recordPreviewLoad.execute(appId, source);
                sendJson(response, 200, { ok: true });
                return;
            case 'errors': {
                const errors = toBuildErrors(body['errors']);
                if (errors.length === 0) throw new HttpError(400, 'An errors report needs at least one error', 'invalid_report');
                hub.recordErrors(appId, errors);
                const recorded = await useCases.recordPreviewErrors.execute(appId, errors, revision, source);
                // An owner app's errors are kept by the hub only, until its preview log moves to the parts (epic 3)
                if (recorded.kind === 'not-found' && (await options.instances?.find(appId)) === undefined) throw new HttpError(404, 'No app with this id', 'not_found');
                hub.touch(appId, viewId);
                sendJson(response, 200, { ok: true });
                return;
            }
            case 'state': {
                const state = body['state'];
                if (typeof body['requestId'] !== 'string' || (state !== null && !isJsonObject(state))) {
                    throw new HttpError(400, 'A state report has a requestId and a state object or null', 'invalid_report');
                }
                hub.resolveState(appId, body['requestId'], state);
                hub.touch(appId, viewId);
                sendJson(response, 200, { ok: true });
                return;
            }
            default:
                throw new HttpError(400, 'Unknown report type', 'invalid_report');
        }
    }

    async function uploadRoute(request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const contentType = request.headers['content-type'] ?? '';
        if (!/^multipart\/form-data/i.test(contentType)) throw new HttpError(400, 'Send multipart/form-data with one field named file', 'invalid_upload');
        const result = await new Promise<UploadFileResult | undefined>((resolve, reject) => {
            const parser = busboy({ headers: request.headers, limits: { files: 1, fields: 0, parts: 2, fileSize: MAX_FILE_BYTES + 1 } });
            let upload: Promise<UploadFileResult> | undefined;
            parser.on('file', (field, stream, info) => {
                if (field !== 'file' || upload !== undefined) {
                    stream.resume();
                    return;
                }
                // A refusal that comes before the bytes are read leaves the stream unread; drain it so the parser can finish
                upload = useCases.uploadFile.execute(appId, { name: info.filename, content: stream }).finally(() => stream.resume());
            });
            parser.on('error', reject);
            parser.on('close', () => {
                if (upload === undefined) resolve(undefined);
                else upload.then(resolve, reject);
            });
            request.pipe(parser);
        });
        if (result === undefined) throw new HttpError(400, 'The upload has no file field', 'invalid_upload');
        switch (result.kind) {
            case 'uploaded':
                sendJson(response, 201, { id: result.file.id, name: result.file.name, size: result.file.size, type: result.file.type });
                return;
            case 'not-found':
                throw new HttpError(404, 'No app with this id', 'not_found');
            case 'too-large':
                throw new HttpError(413, 'A file is at most 10 MiB', 'too_large');
            case 'empty':
            case 'unsupported-type':
                throw new HttpError(415, 'This file type is not allowed, or the file is empty', 'unsupported_type');
            case 'quota':
                sendJson(response, 409, { error: 'quota', reason: result.reason });
                return;
        }
    }

    async function downloadRoute(response: ServerResponse, appId: string, fileId: string): Promise<void> {
        if (!isAppId(fileId)) throw new HttpError(400, 'A file id is a UUID', 'invalid_id');
        const result = await useCases.readFile.execute(appId, fileId);
        if (result.kind === 'not-found') throw new HttpError(404, 'No file with this id', 'not_found');
        const encoded = encodeURIComponent(result.file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        response.writeHead(200, {
            'Content-Type': result.file.type,
            'Content-Length': String(result.file.size),
            'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
            'Content-Security-Policy': FILE_CSP,
            ...COMMON_HEADERS
        });
        result.content.pipe(response);
    }

    const handler = (handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) => (request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
            try {
                if (!isAllowedHost(request.headers.host, options.host)) throw new HttpError(403, 'The Host header is not one this server answers to', 'forbidden_host');
                if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) throw new HttpError(403, 'Cross-origin requests are refused', 'forbidden_origin');
                await handle(request, response);
            } catch (error) {
                if (response.headersSent) {
                    response.end();
                    return;
                }
                if (error instanceof HttpError) {
                    sendError(response, error);
                    return;
                }
                report.info('Request failed', { path: request.url?.split('?')[0], error: error instanceof Error ? error.message : String(error) });
                sendError(response, new HttpError(500, 'Internal error', 'internal_error'));
            }
        })();
    };

    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_SYNC_FRAME_BYTES });

    /** Refuses an upgrade with a plain HTTP answer and closes the socket */
    function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }

    /**
     * `GET /apps/:appId/sync`: the WebSocket of one view. The view joins the hub (document, commands, locale, theme and
     * deletion reach it as `{ type: 'view', message }` frames, the attach message first) and connects to the app's
     * sync authority, which gets every other text frame. Closing the socket leaves both
     */
    async function syncUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        if (!isAllowedHost(request.headers.host, options.host)) return refuseUpgrade(socket, 403, 'Forbidden');
        // A browser always sends Origin with a WebSocket, so a page of another origin cannot open one
        if (!isSameOrigin(request)) return refuseUpgrade(socket, 403, 'Forbidden');
        const url = new URL(request.url ?? '/', 'http://localhost');
        const parts = url.pathname.split('/').filter((part) => part !== '');
        const appId = parts[1];
        const viewId = url.searchParams.get('view');
        if (parts.length !== 3 || parts[0] !== 'apps' || parts[2] !== 'sync' || appId === undefined || !isAppId(appId)) return refuseUpgrade(socket, 404, 'Not Found');
        if (!isUuid(viewId)) return refuseUpgrade(socket, 400, 'Bad Request');
        const app = await repository.findById(appId);
        const part = app === undefined ? await options.instances?.find(appId) : undefined;
        const first = app === undefined && part === undefined ? undefined : await liveViews.attachMessage(appId);
        if (first === undefined) return refuseUpgrade(socket, 404, 'Not Found');
        // A Persisted app's views sync with the statenet; this socket carries only their view frames. An owner app's
        // views sync with the default persona's instance
        let authority: Authority | undefined;
        if (part !== undefined) authority = await options.instances?.authority(part);
        else if (app !== undefined && app.sync !== 'persisted') authority = await authorities.authority(appId, app.document);
        sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
            const sendView = (message: ViewMessage): void => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'view', message }));
            };
            const connection: ViewConnection = { id: viewId, kind: url.searchParams.get('kind') === 'headless' ? 'headless' : 'browser', send: sendView };
            const detach = hub.attach(appId, connection);
            sendView(first);
            const session = authority?.connect({
                send: (text) => {
                    if (ws.readyState === ws.OPEN) ws.send(text);
                },
                close: () => ws.close()
            });
            const timer = setInterval(() => ws.ping(), KEEP_ALIVE_MS);
            ws.on('message', (data, isBinary) => {
                if (isBinary) {
                    ws.close(1003, 'Text frames only');
                    return;
                }
                hub.touch(appId, viewId);
                session?.receive(Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
            });
            ws.on('error', () => ws.terminate());
            ws.on('close', () => {
                clearInterval(timer);
                session?.close();
                detach();
            });
        });
    }

    const listen = (target: Server, port: number): Promise<AddressInfo> =>
        new Promise<AddressInfo>((resolve, reject) => {
            target.once('error', reject);
            target.listen(port, options.host, () => {
                target.off('error', reject);
                resolve(target.address() as AddressInfo);
            });
        });
    const stop = async (target: Server): Promise<void> => {
        if (!target.listening) return;
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
    };

    const server: Server = createServer(handler(route));
    const runtimeServer: Server = createServer(handler(runtimeRoute));
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        socket.on('error', () => socket.destroy());
        syncUpgrade(request, socket, head).catch((error: unknown) => {
            report.info('Sync connection failed', { path: request.url?.split('?')[0], error: error instanceof Error ? error.message : String(error) });
            if (!socket.destroyed) refuseUpgrade(socket, 500, 'Internal Server Error');
        });
    });
    const address = await listen(server, options.port);
    mainPort = address.port;
    try {
        runtimePort = (await listen(runtimeServer, options.runtimePort)).port;
    } catch (error) {
        await stop(server);
        throw error instanceof Error ? new Error(`The runtime port ${options.runtimePort}: ${error.message}`) : error;
    }
    const hostForUrl = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return {
        origin: `http://${hostForUrl}:${address.port}`,
        port: address.port,
        runtimePort,
        close: async () => {
            // Upgraded sockets are no longer the HTTP server's connections
            for (const client of sockets.clients) client.terminate();
            sockets.close();
            await Promise.all([stop(server), stop(runtimeServer)]);
        }
    };
}
