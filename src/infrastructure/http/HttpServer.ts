import busboy from 'busboy';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UiAppRepository } from '../../application/ports/UiAppRepository.js';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';
import type { UploadFileResult } from '../../application/use-cases/UploadFile.js';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonValue } from '../../domain/JsonValue.js';
import { MAX_FILE_BYTES } from '../../domain/UiFile.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { isAppId } from '../storage/AppFolders.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { PreviewHub, ViewConnection, ViewMessage } from '../preview/PreviewHub.js';
import { appPage, indexPage, PAGE_CSS } from './pages.js';
import type { RuntimeBundle } from './runtimeBundle.js';
import { runtimePage } from './runtimeBundle.js';
import { COMMON_HEADERS, FILE_CSP, HOST_PAGE_CSP, isAllowedHost, isSameOrigin, LIST_PAGE_CSP, RUNTIME_CSP } from './security.js';

/** The MCP side of `/mcp`: sessions of the streamable HTTP transport */
export interface McpEndpoint {
    handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void>;
    close(): Promise<void>;
}

export interface HttpServerOptions {
    readonly host: string;
    readonly port: number;
    readonly useCases: UiBuilderUseCases;
    readonly repository: UiAppRepository;
    readonly hub: PreviewHub;
    readonly liveViews: LiveViews;
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
    close(): Promise<void>;
}

const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BODY_BYTES = 2 * 1024 * 1024;
const KEEP_ALIVE_MS = 15_000;
const MAX_EVENT_NAME = 256;
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
 * | `GET /apps/:appId` | the live view of an app |
 * | `GET /apps/:appId/events` | the event stream of a view (server to view) |
 * | `POST /apps/:appId/report` | what a view tells the server: state, `emit` events, errors, ready |
 * | `POST /apps/:appId/files` | an upload from a `fileField` (multipart, one field `file`) |
 * | `GET /apps/:appId/files/:fileId` | the bytes of an upload, as an attachment |
 * | `GET /assets/host.js`, `/assets/page.css` | the host script and the stylesheet |
 * | `GET /runtime/<hash>.html`, `/runtime/<hash>.js` | the content-hashed StateUI runtime page and bundle |
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
    const { useCases, repository, hub, liveViews, runtime, report } = options;
    const runtimePageBuffer = Buffer.from(runtimePage(runtime.hash), 'utf8');
    const runtimeBase = '/runtime';

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
        if (method === 'GET' && path === `${runtimeBase}/${runtime.hash}.html`) {
            send(response, 200, 'text/html; charset=utf-8', runtimePageBuffer, { 'Content-Security-Policy': RUNTIME_CSP, 'Cache-Control': 'no-cache' });
            return;
        }
        if (method === 'GET' && path === `${runtimeBase}/${runtime.hash}.js`) {
            send(response, 200, 'text/javascript; charset=utf-8', runtime.script, {
                'Content-Security-Policy': RUNTIME_CSP,
                'Cache-Control': 'public, max-age=31536000, immutable',
                // The frame is sandboxed without allow-same-origin, so its origin is opaque and its script load is cross-origin
                'Cross-Origin-Resource-Policy': 'cross-origin'
            });
            return;
        }

        const parts = path.split('/').filter((part) => part !== '');
        if (parts[0] === 'apps' && parts[1] !== undefined && SEGMENT.test(parts[1])) {
            const appId = parts[1];
            if (!isAppId(appId)) throw new HttpError(400, 'An app id is a UUID', 'invalid_id');
            const rest = parts.slice(2);
            if (method === 'GET' && rest.length === 0) return appRoute(request, response, appId);
            if (method === 'GET' && rest.length === 1 && rest[0] === 'events') return eventsRoute(request, response, appId, url);
            if (method === 'POST' && rest.length === 1 && rest[0] === 'report') return reportRoute(request, response, appId);
            if (method === 'POST' && rest.length === 1 && rest[0] === 'files') return uploadRoute(request, response, appId);
            if (method === 'GET' && rest.length === 2 && rest[0] === 'files' && rest[1] !== undefined) return downloadRoute(response, appId, rest[1]);
        }
        throw new HttpError(404, 'Not found', 'not_found');
    }

    async function appRoute(request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const app = await repository.findById(appId);
        if (app === undefined) throw new HttpError(404, 'No app with this id', 'not_found');
        const headless = /HeadlessChrome/.test(request.headers['user-agent'] ?? '');
        send(
            response,
            200,
            'text/html; charset=utf-8',
            appPage({ appId, name: app.name, runtimeUrl: `${runtimeBase}/${runtime.hash}.html`, viewKind: headless ? 'headless' : 'browser' }),
            { 'Content-Security-Policy': HOST_PAGE_CSP, 'Cache-Control': 'no-store' }
        );
    }

    async function eventsRoute(request: IncomingMessage, response: ServerResponse, appId: string, url: URL): Promise<void> {
        const viewId = url.searchParams.get('view');
        if (!isUuid(viewId)) throw new HttpError(400, 'The view parameter is a UUID', 'invalid_view');
        const first = await liveViews.attachMessage(appId);
        if (first === undefined) throw new HttpError(404, 'No app with this id', 'not_found');

        response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...COMMON_HEADERS
        });
        const write = (message: ViewMessage): void => {
            response.write(`data: ${JSON.stringify(message)}\n\n`);
        };
        const connection: ViewConnection = {
            id: viewId,
            kind: url.searchParams.get('kind') === 'headless' ? 'headless' : 'browser',
            send: write
        };
        const detach = hub.attach(appId, connection);
        const timer = setInterval(() => response.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
        let closed = false;
        const cleanup = (): void => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            detach();
        };
        request.on('close', cleanup);
        response.on('close', cleanup);
        write(first);
    }

    async function reportRoute(request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const body = await readJsonBody(request, MAX_REPORT_BODY_BYTES);
        if (!isJsonObject(body) || !isUuid(typeof body['viewId'] === 'string' ? body['viewId'] : null)) {
            throw new HttpError(400, 'A report is a JSON object with a viewId', 'invalid_report');
        }
        const viewId = body['viewId'] as string;
        const revision = typeof body['revision'] === 'number' ? body['revision'] : undefined;
        switch (body['type']) {
            case 'ready':
                hub.touch(appId, viewId, { ready: true, ...(revision !== undefined && { revision }) });
                sendJson(response, 200, { ok: true });
                return;
            case 'rendered':
                hub.touch(appId, viewId, { ...(revision !== undefined && { revision }) });
                sendJson(response, 200, { ok: true });
                return;
            case 'state': {
                if (revision === undefined) throw new HttpError(400, 'A state report needs the revision it rendered', 'invalid_report');
                const saved = await useCases.savePreviewState.execute(appId, { snapshot: body['snapshot'] as JsonValue, expectedRevision: revision });
                hub.touch(appId, viewId);
                if (saved.kind === 'saved') sendJson(response, 200, { ok: true, revision: saved.revision });
                else if (saved.kind === 'conflict') sendJson(response, 409, { error: 'conflict', currentRevision: saved.currentRevision });
                else if (saved.kind === 'not-found') throw new HttpError(404, 'No app with this id', 'not_found');
                else throw new HttpError(400, saved.reason, 'invalid_report');
                return;
            }
            case 'emit': {
                const name = body['name'];
                if (typeof name !== 'string' || name === '' || name.length > MAX_EVENT_NAME) throw new HttpError(400, 'An emit report needs a name', 'invalid_report');
                if ((await repository.findById(appId)) === undefined) throw new HttpError(404, 'No app with this id', 'not_found');
                hub.recordEvent(appId, viewId, name, body['payload'] as JsonValue | undefined);
                hub.touch(appId, viewId);
                sendJson(response, 200, { ok: true });
                return;
            }
            case 'errors': {
                const errors = toBuildErrors(body['errors']);
                if (errors.length === 0) throw new HttpError(400, 'An errors report needs at least one error', 'invalid_report');
                hub.recordErrors(appId, errors);
                const recorded = await useCases.recordPreviewErrors.execute(appId, errors, revision);
                if (recorded.kind === 'not-found') throw new HttpError(404, 'No app with this id', 'not_found');
                hub.touch(appId, viewId);
                sendJson(response, 200, { ok: true });
                return;
            }
            case 'snapshot-reply': {
                const requestId = body['requestId'];
                const snapshot = body['snapshot'];
                if (typeof requestId !== 'string' || (snapshot !== null && !isJsonObject(snapshot))) throw new HttpError(400, 'A snapshot reply needs a requestId and a snapshot', 'invalid_report');
                hub.answerSnapshot(appId, requestId, snapshot);
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
                upload = useCases.uploadFile.execute(appId, { name: info.filename, content: stream });
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

    const server: Server = createServer((request, response) => {
        void (async () => {
            try {
                if (!isAllowedHost(request.headers.host, options.host)) throw new HttpError(403, 'The Host header is not one this server answers to', 'forbidden_host');
                if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) throw new HttpError(403, 'Cross-origin requests are refused', 'forbidden_origin');
                await route(request, response);
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
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    const hostForUrl = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return {
        origin: `http://${hostForUrl}:${address.port}`,
        port: address.port,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
}
