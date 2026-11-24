import busboy from 'busboy';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { report as reportArea } from '@punyts/core';
import { compilePattern, matchPattern } from '@punyts/state';
import type { PathPattern } from '@punyts/state';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';
import type { ByteRange } from '../../application/ports/UiFileStore.js';
import type { UploadFileResult } from '../../application/use-cases/UploadFile.js';
import { buildRecordsCsv, csvHeaders } from '../../application/recordsCsv.js';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { MAX_FILE_BYTES } from '../../domain/UiFile.js';
import { isAppId } from '../storage/PartFolders.js';
import type { InstanceViews } from '../preview/InstanceViews.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { AuthoritySession } from '@punyts/state-sync/authority';
import { DEFAULT_PERSONA } from '../../domain/InstanceKey.js';
import { createSyncWire, REVOKED_CODE, wireTypeOf } from '@punyts/state-sync';
import type { SyncWire } from '@punyts/state-sync';
import type { PreviewHub, ViewConnection, ViewMessage } from '../preview/PreviewHub.js';
import { takeViewReport } from '../preview/viewReports.js';
import { appPage, indexPage, PAGE_CSS } from './pages.js';
import type { RuntimeBundle, RuntimeChunk } from './runtimeBundle.js';
import { RUNTIME_CSS, runtimePage } from './runtimeBundle.js';
import { byteRange } from './byteRange.js';
import { appFilesPattern, MemoryGrantKeys, PATH_TOKEN_RENEW_MS, PathTokens, type GrantKeys, type PathReader } from './PathTokens.js';
import { APP_PAGE_CSP, COMMON_HEADERS, FILE_CSP, hostPageCsp, isAllowedHost, isPublicHost, isSameOrigin, LIST_PAGE_CSP, requestHostName, runtimeCsp } from './security.js';

/** The host names of this machine itself */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** What the browser endpoint serves for one owner: their apps, the views of them and their live state */
export interface HttpTenant {
    readonly useCases: UiBuilderUseCases;
    readonly hub: PreviewHub;
    readonly liveViews: LiveViews;
    /** The views of the owner's apps (parts): what a view is sent and the authority its socket talks to */
    readonly instances: InstanceViews;
    /**
     * Told when a view's socket opens, with a function that closes it (with 1008 and the reason given, such as on
     * sign-out; with `revoked`, the view is first sent the sync error `revoked`, so it deletes what it keeps of the
     * app); the function it returns is called when the socket closes
     */
    readonly retain?: (close: (reason: string, revoked?: boolean) => void) => () => void;
    /**
     * The persona whose instance of the app the views sync with; default the owner's own (`DEFAULT_PERSONA`). Another
     * person given an app keeps their own state in it under a persona of their own (`isPersonaName`)
     */
    readonly persona?: string;
    /**
     * What the request may do: `owner` (default) anything; `use` run the app with its own state, but not upload or
     * release the app's files; `view` that and no change to the state either: each change a view sends is rejected
     * (`ack` `rejected`) and its events are dropped
     */
    readonly access?: 'owner' | 'use' | 'view';
    /** Who reads the owner's apps through this tenant, as the subject of a `/paths` token; absent: the owner */
    readonly reader?: PathReader;
    /**
     * Sync namespaces the browser deletes before it opens the app (`data-forget`): what it kept of an instance the
     * person no longer has, such as their own after a move from `use` to `view`
     */
    readonly forget?: readonly string[];
}

/**
 * An app taken back from the person asking: its page deletes what the browser keeps of it (`data-revoked`) and shows
 * the message, and its socket answers the sync error `revoked`, so an open page deletes it too
 */
export interface RevokedApp {
    readonly message: string;
    /** The sync namespace the person kept the app's state under */
    readonly namespace: string;
    /** The page's title: never the app's name, which the person no longer has */
    readonly title: string;
}

/**
 * Whose apps a request reaches: the tenant, or a refusal with its status. A page request (`GET` of `/` or of an app)
 * with a `location` is redirected there instead, such as to a sign-in page
 */
export type TenantAnswer = { readonly tenant: HttpTenant } | { readonly refuse: 401 | 403 | 404; readonly location?: string } | { readonly revoked: RevokedApp };

export interface HttpServerOptions {
    readonly host: string;
    readonly port: number;
    /** The port of the runtime origin, which serves only the runtime page, bundle and stylesheet. 0 picks a free port */
    readonly runtimePort: number;
    /**
     * Where people reach the two origins, such as `https://magnetic.example` and `https://run.magnetic.example`, when a
     * proxy stands in front. The pages name them instead of `http://<Host>:<port>`, and only their host names (and
     * loopback) are answered. Absent: each origin is the request's host name with that origin's port
     */
    readonly publicOrigins?: PublicOrigins;
    /**
     * Also listen on an address of the local network, over HTTPS with this key and certificate (PEM), on the same two
     * ports: so other computers reach the server while `host` stays loopback. Its pages name `https://<Host>:<port>`
     */
    readonly network?: NetworkListener;
    /** The one owner of a local server, or how a request finds its owner on a server with many */
    readonly tenant: HttpTenant | ((request: IncomingMessage) => Promise<TenantAnswer>);
    /**
     * The tenant of an owner named in a `/paths` URL (`HttpTenant.instances.owner`), for a read with a token and no
     * cookie; undefined when there is none. Absent: the one tenant of a local server, when it is that owner
     */
    readonly ownerTenant?: (owner: string) => Promise<HttpTenant | undefined>;
    /**
     * The owners' signing keys and the revocations the tokens of `/paths` are signed and checked with, the same on every
     * server of a host. Absent: keys this server makes and keeps in memory (`MemoryGrantKeys`)
     */
    readonly grantKeys?: GrantKeys;
    /**
     * Routes of the embedding server, tried before the endpoint's own and after the host and origin checks: true when
     * they answered the request. A thrown `HttpError` is answered with its status and code
     */
    readonly routes?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
    /**
     * Whether a `POST` to this path of the main origin is taken from a page of another origin, such as a SAML identity
     * provider's answer, which the browser posts from the provider's page. Every other request with an `Origin` of
     * another host is refused. The route itself must check what it is sent
     */
    readonly crossOriginPost?: (path: string) => boolean;
    /** The text frames one view's socket may send per second, with a burst of twice as many; absent: no limit */
    readonly socketMessagesPerSecond?: number;
    readonly runtime: RuntimeBundle;
    /** The 3D renderer chunk of `@punyts/stateui-3d`, served beside the runtime; absent when it is not installed */
    readonly chunk3d?: RuntimeChunk;
    /** The compiled host script, served as `/assets/host.js` */
    readonly hostScript: Buffer;
    readonly report: UseCaseReport;
}

/** The second listener of a server reached from the local network: its address and its TLS key and certificate (PEM) */
export interface NetworkListener {
    readonly host: string;
    readonly key: string;
    readonly cert: string;
}

/** Whether a request came over the network listener's TLS */
export function isNetworkRequest(request: IncomingMessage): boolean {
    return (request.socket as Partial<TLSSocket>).encrypted === true;
}

/** The two public origins of a server behind a proxy: the pages', and the runtime frame's, which must differ */
export interface PublicOrigins {
    readonly main: string;
    readonly runtime: string;
}

export interface RunningHttpServer {
    /** The origin the server listens on, such as `http://127.0.0.1:4100`. Known after `listen`, so a port of 0 works */
    readonly origin: string;
    readonly port: number;
    /** The port of the runtime origin */
    readonly runtimePort: number;
    /** The origin of the network listener, such as `https://192.168.1.20:4100`, when there is one */
    readonly networkOrigin?: string;
    close(): Promise<void>;
}

const MAX_REPORT_BODY_BYTES = 2 * 1024 * 1024;
/** An export request names columns, filters and a sort, never rows: the runtime caps its message at 64 KiB */
const MAX_EXPORT_BODY_BYTES = 64 * 1024;
const KEEP_ALIVE_MS = 15_000;
/** A sync message is at most 1,000,000 characters (`parseMessage`); a frame may hold that many bytes of UTF-8 twice over */
const MAX_SYNC_FRAME_BYTES = 4 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** An error a route answers with: its status, and `{ error: code, message }` as the body */
export class HttpError extends Error {
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

/** A segment of a `/paths` URL: a key of a statenet path, which has no dot */
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,200}$/;

/** The types a browser shows in place: pictures, audio and video. An SVG is a document, so it is an attachment */
const INLINE_TYPE = /^(?:image\/(?!svg)|audio\/|video\/)/i;

/** The `/paths` URL under which an app's files are read */
export function appPaths(owner: string, appId: string): string {
    return `/paths/${encodeURIComponent(owner)}/apps/${appId.toLowerCase()}`;
}

/** A file name as `filename*=UTF-8''` takes it */
function dispositionName(name: string): string {
    return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** One read of a `/paths` source */
interface PathRead {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    /** A `HEAD`: the headers only */
    readonly head: boolean;
    /** The read token of the query, `g` (a `/paths` token, `PathTokens`) */
    readonly grant?: string;
}

/** A row of the sources table of `/paths`: a pattern, and the read of a path that matches it with its captures */
interface PathSource {
    readonly pattern: PathPattern;
    read(captures: Readonly<Record<string, string>>, ask: PathRead): Promise<void>;
}

/** The category of the view server's reports: listening, and a view page served */
const PREVIEW_CATEGORY = 'stateui-mcp.preview';

/**
 * The browser endpoint of a server that serves its own view pages, for people and for Playwright: what an embedding
 * server with sign-in and many owners uses (Magnetic). The stateui-mcp server itself serves no HTTP: its views live
 * in a statenet (`StatenetViews`) and their pages come from Vite or a CDN.
 *
 * | Route | What |
 * |---|---|
 * | `GET /` | the app parts, with a link to each |
 * | `GET /apps/:appId` | the live view of an app part: assembled, with the default persona's instance |
 * | `GET /apps/:appId/sync?view=<uuid>&kind=browser\|headless` | the WebSocket of a view: the state-sync protocol with the app's authority, and `{ type: 'view', message }` frames for the document, commands, locale, theme and deletion |
 * | `POST /apps/:appId/report` | what a view tells the server: ready, rendered, errors |
 * | `POST /apps/:appId/files` | an upload from a `fileField` (multipart, one field `file`) |
 * | `POST /apps/:appId/export` | a CSV file of records in the persona's own instance: `{ source, name, request }` (`RecordExportRequest`), filtered and sorted here; never rows from the browser |
 * | `DELETE /apps/:appId/files/:fileId` | releases an upload: `204` removed, `409` kept because the app's definition or live state still references it, `404` no such file |
 * | `GET /paths/<owner>/apps/:appId/files/:fileId` | the bytes of an upload by its statenet path (`pathsRoute`): byte ranges, inline for pictures, audio and video, read with the session or a `/paths` token `?g=` (`PathTokens`) |
 * | `GET /assets/host.js`, `/assets/page.css` | the host script and the stylesheet |
 *
 * A second listener on `runtimePort` is the runtime origin. It serves only the app frame:
 *
 * | Route | What |
 * |---|---|
 * | `GET /runtime/<hash>.html`, `/runtime/<hash>.js`, `/runtime/runtime.css` | the content-hashed StateUI runtime page and bundle, and the page's stylesheet |
 * | `GET /runtime/<chunk hash>.js` | the content-hashed 3D renderer chunk, when `@punyts/stateui-3d` is installed; the app page names it in `data-chunk-3d` |
 *
 * The frame is sandboxed with `allow-scripts allow-same-origin`. Its own origin keeps it apart from the host page, and
 * browsers that refuse a frame with an opaque origin (some embedded browsers) still show it
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
    const { runtime, chunk3d, report } = options;
    const fixed = typeof options.tenant === 'function' ? undefined : { tenant: options.tenant };
    const findTenant = fixed === undefined ? (options.tenant as (request: IncomingMessage) => Promise<TenantAnswer>) : async (): Promise<TenantAnswer> => fixed;

    /** The tenant of a request; a refusal is thrown, or redirected for a page with a location (then `undefined`) */
    async function tenantOf(request: IncomingMessage, response: ServerResponse, page: boolean): Promise<HttpTenant | undefined> {
        const answer = await findTenant(request);
        if ('tenant' in answer) return answer.tenant;
        if ('revoked' in answer) throw new HttpError(403, answer.revoked.message, 'revoked');
        if (page && answer.location !== undefined) {
            response.writeHead(303, { ...COMMON_HEADERS, Location: answer.location, 'Cache-Control': 'no-store' });
            response.end();
            return undefined;
        }
        if (answer.refuse === 404) throw new HttpError(404, 'Not found', 'not_found');
        throw new HttpError(answer.refuse, answer.refuse === 401 ? 'Sign in first' : 'Not allowed', answer.refuse === 401 ? 'unauthorized' : 'forbidden');
    }
    const grants = new PathTokens(options.grantKeys ?? new MemoryGrantKeys());
    const ownerTenant = options.ownerTenant ?? (async (owner: string): Promise<HttpTenant | undefined> => (fixed !== undefined && fixed.tenant.instances.owner === owner ? fixed.tenant : undefined));
    const runtimePageBuffer = Buffer.from(runtimePage(runtime.hash), 'utf8');
    const runtimeBase = '/runtime';
    // Both known after listen, so a port of 0 works
    let mainPort = 0;
    let runtimePort = 0;

    const publicHosts = options.publicOrigins === undefined ? undefined : new Set([new URL(options.publicOrigins.main).hostname, new URL(options.publicOrigins.runtime).hostname]);
    const hostAllowed = (request: IncomingMessage): boolean => {
        if (publicHosts !== undefined) return isPublicHost(request.headers.host, publicHosts);
        return isAllowedHost(request.headers.host, options.network !== undefined && isNetworkRequest(request) ? options.network.host : options.host);
    };
    /** The scheme a request came over: HTTPS on the network listener */
    const schemeOf = (request: IncomingMessage): string => (isNetworkRequest(request) ? 'https' : 'http');
    /**
     * The public origins of a request, or `undefined` for a request to a loopback name: one from this machine, such as
     * the server's own headless browser, is answered with the loopback origins, so its page and its runtime frame are
     * this server's and not whichever one the proxy picks
     */
    const publicOriginsOf = (request: IncomingMessage): PublicOrigins | undefined => (options.publicOrigins !== undefined && !LOOPBACK_NAMES.has(hostNameOf(request)) ? options.publicOrigins : undefined);
    /** The origin of the pages, as the browser of a request reaches it */
    const mainOriginOf = (request: IncomingMessage): string => publicOriginsOf(request)?.main ?? `${schemeOf(request)}://${hostNameOf(request)}:${mainPort}`;
    /** The origin of the runtime frame, as the browser of a request reaches it */
    const runtimeOriginOf = (request: IncomingMessage): string => publicOriginsOf(request)?.runtime ?? `${schemeOf(request)}://${hostNameOf(request)}:${runtimePort}`;

    /** The host name the request used, so the other origin is reached by the same name */
    function hostNameOf(request: IncomingMessage): string {
        const name = requestHostName(request.headers.host);
        if (name === undefined) throw new HttpError(400, 'The Host header is not a host name', 'bad_host');
        return name;
    }

    async function runtimeRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (request.method === 'GET' && path === `${runtimeBase}/${runtime.hash}.html`) {
            const csp = runtimeCsp(mainOriginOf(request));
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
        if (chunk3d !== undefined && request.method === 'GET' && path === `${runtimeBase}/${chunk3d.hash}.js`) {
            send(response, 200, 'text/javascript; charset=utf-8', chunk3d.script, { 'Cache-Control': 'public, max-age=31536000, immutable' });
            return;
        }
        throw new HttpError(404, 'Not found', 'not_found');
    }

    /** The script `/assets/page/<hash>.js` names: the page bundle or the 3D chunk; undefined for any other path */
    function pageAsset(path: string): Buffer | undefined {
        const page = runtime.page;
        if (page === undefined) return undefined;
        if (path === `/assets/page/${page.hash}.js`) return page.script;
        if (chunk3d !== undefined && path === `/assets/page/${chunk3d.hash}.js`) return chunk3d.script;
        return undefined;
    }

    async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = request.method ?? 'GET';

        if (options.routes !== undefined && (await options.routes(request, response))) return;
        if (method === 'GET' && path === '/') {
            const tenant = await tenantOf(request, response, true);
            if (tenant === undefined) return;
            // The owner's app parts, the most recently changed first
            const apps = [...(await tenant.instances.list())].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
            send(response, 200, 'text/html; charset=utf-8', indexPage(apps), { 'Content-Security-Policy': LIST_PAGE_CSP, 'Cache-Control': 'no-store' });
            return;
        }
        if (method === 'GET' && path === '/assets/host.js') {
            send(response, 200, 'text/javascript; charset=utf-8', options.hostScript, { 'Cache-Control': 'no-cache' });
            return;
        }
        // The page bundle and the 3D chunk it loads from its own folder, for an app that runs in the page (`?surface=page`)
        const pageScript = method === 'GET' ? pageAsset(path) : undefined;
        if (pageScript !== undefined) {
            send(response, 200, 'text/javascript; charset=utf-8', pageScript, { 'Cache-Control': 'public, max-age=31536000, immutable' });
            return;
        }
        if (method === 'GET' && path === '/assets/page.css') {
            send(response, 200, 'text/css; charset=utf-8', PAGE_CSS, { 'Cache-Control': 'no-cache' });
            return;
        }

        const parts = path.split('/').filter((part) => part !== '');
        if ((method === 'GET' || method === 'HEAD') && parts[0] === 'paths') return pathsRoute(request, response, url, parts.slice(1), method === 'HEAD');
        if (parts[0] === 'apps' && parts[1] !== undefined && SEGMENT.test(parts[1])) {
            const appId = parts[1];
            if (!isAppId(appId)) throw new HttpError(400, 'An app id is a UUID', 'invalid_id');
            const rest = parts.slice(2);
            const page = method === 'GET' && rest.length === 0;
            const fileId = rest.length === 2 && rest[0] === 'files' ? rest[1] : undefined;
            const known = page || (method === 'POST' && rest.length === 1 && (rest[0] === 'report' || rest[0] === 'files' || rest[0] === 'export')) || (method === 'DELETE' && fileId !== undefined);
            if (known) {
                if (page) {
                    const answer = await findTenant(request);
                    if ('revoked' in answer) return revokedRoute(answer.revoked, request, response, appId);
                }
                const tenant = await tenantOf(request, response, page);
                if (tenant === undefined) return;
                if (page) return appRoute(tenant, request, response, appId);
                const owner = (tenant.access ?? 'owner') === 'owner';
                if (method === 'POST' && rest[0] === 'report') return reportRoute(tenant, request, response, appId);
                if (method === 'POST' && rest[0] === 'export') return exportRoute(tenant, request, response, appId);
                if (!owner) throw new HttpError(403, "Only the app's owner adds or removes its files", 'forbidden');
                if (method === 'POST') return uploadRoute(tenant, request, response, appId);
                return releaseRoute(tenant, response, appId, fileId as string);
            }
        }
        throw new HttpError(404, 'Not found', 'not_found');
    }

    /** The page of an app taken back: it deletes what the browser keeps of the app and says why */
    function revokedRoute(revoked: RevokedApp, request: IncomingMessage, response: ServerResponse, appId: string): void {
        const runtimeOrigin = runtimeOriginOf(request);
        send(
            response,
            200,
            'text/html; charset=utf-8',
            appPage({ appId, name: revoked.title, runtimeUrl: `${runtimeOrigin}${runtimeBase}/${runtime.hash}.html`, viewKind: 'browser', namespace: revoked.namespace, revoked: revoked.message }),
            { 'Content-Security-Policy': hostPageCsp(runtimeOrigin), 'Cache-Control': 'no-store' }
        );
    }

    async function appRoute({ instances, persona, forget, reader }: HttpTenant, request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const part = await instances.find(appId);
        if (part === undefined) throw new HttpError(404, 'No app with this id', 'not_found');
        const headless = /HeadlessChrome/.test(request.headers['user-agent'] ?? '');
        const runtimeOrigin = runtimeOriginOf(request);
        // `?surface=page`: the app runs in the page itself, with the page bundle, when the build made one
        const inPage = new URL(request.url ?? '/', 'http://localhost').searchParams.get('surface') === 'page' ? runtime.page : undefined;
        reportArea(PREVIEW_CATEGORY, 'View page served', { appId, viewKind: headless ? 'headless' : 'browser', surface: inPage === undefined ? 'frame' : 'page' });
        send(
            response,
            200,
            'text/html; charset=utf-8',
            appPage({
                appId,
                name: part.name,
                runtimeUrl: `${runtimeOrigin}${runtimeBase}/${runtime.hash}.html`,
                ...(chunk3d !== undefined && { chunk3d: chunk3d.hash }),
                ...(inPage !== undefined && { pageBundle: inPage.hash }),
                viewKind: headless ? 'headless' : 'browser',
                namespace: instances.namespace(part, persona),
                ...(forget !== undefined && forget.length > 0 && { forget }),
                paths: appPaths(instances.owner, part.id),
                grant: await grants.issue(instances.owner, part.id, reader)
            }),
            { 'Content-Security-Policy': inPage === undefined ? hostPageCsp(runtimeOrigin) : APP_PAGE_CSP, 'Cache-Control': 'no-store' }
        );
    }

    async function reportRoute(tenant: HttpTenant, request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const outcome = await takeViewReport(tenant, appId, await readJsonBody(request, MAX_REPORT_BODY_BYTES));
        if (outcome.kind === 'invalid') throw new HttpError(400, outcome.message, 'invalid_report');
        if (outcome.kind === 'not-found') throw new HttpError(404, 'No app with this id', 'not_found');
        sendJson(response, 200, { ok: true });
    }

    /**
     * A CSV export (`fileExport` of the runtime, through the host page): the records at `source` in the requesting
     * persona's own instance, so the file holds only what that persona can read (a shared dataset whole, a persona
     * binding's own records, another owner's share), filtered, sorted and cut to the columns as the grid shows them. The
     * browser sends the settings, never rows; nothing is stored. Logs the app, the source and the row count, never a value
     */
    async function exportRoute(tenant: HttpTenant, request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
        const body = await readJsonBody(request, MAX_EXPORT_BODY_BYTES);
        const app = await tenant.instances.find(appId);
        if (app === undefined) throw new HttpError(404, 'No app with this id', 'not_found');
        const result = await buildRecordsCsv(appId, body, async (source) => (await tenant.instances.authority(app, tenant.persona ?? DEFAULT_PERSONA)).get(source), report);
        if (result.kind === 'refused') throw new HttpError(result.status, result.message, result.code);
        const { 'content-type': contentType, ...headers } = csvHeaders(result.name, result.rows);
        send(response, 200, contentType as string, result.csv, { ...headers, 'Content-Security-Policy': FILE_CSP });
    }

    async function uploadRoute({ useCases }: HttpTenant, request: IncomingMessage, response: ServerResponse, appId: string): Promise<void> {
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

    /** The sources of `/paths`: a path pattern and how the bytes under it are read. Tiles join when they are built */
    const sources: readonly PathSource[] = [{ pattern: compilePattern('$.{owner}.apps.{app}.files.{file}') as PathPattern, read: fileSource }];

    /**
     * `GET` or `HEAD` of `/paths/<segments>`: the statenet path `$.<segment>.<segment>…`, read by the first source whose
     * pattern it matches exactly (no deeper or shallower path). A path no source matches, and one the reader may not read,
     * are both `404`, so the route does not tell which paths exist. The query is only a token, `g`
     */
    async function pathsRoute(request: IncomingMessage, response: ServerResponse, url: URL, segments: readonly string[], head: boolean): Promise<void> {
        if (segments.length === 0 || !segments.every((segment) => PATH_SEGMENT.test(segment))) throw new HttpError(404, 'Not found', 'not_found');
        const grant = url.searchParams.getAll('g');
        if ([...url.searchParams.keys()].some((key) => key !== 'g') || grant.length > 1) throw new HttpError(400, 'A /paths URL takes no query but its grant, g', 'bad_query');
        const path = `$.${segments.join('.')}`;
        for (const source of sources) {
            if (source.pattern.steps.length !== segments.length) continue;
            const [found] = matchPattern(source.pattern, path);
            if (found !== undefined) return source.read(found.captures, { request, response, head, ...(grant[0] !== undefined && { grant: grant[0] }) });
        }
        throw new HttpError(404, 'Not found', 'not_found');
    }

    /**
     * Who reads `path` of `owner`: with a token, the owner's tenant when the token lets its holder read the path; without,
     * the tenant of the request's session, when it is that owner's (the owner, an org member, a person given the app)
     */
    async function readerOf(request: IncomingMessage, owner: string, path: string, grant: string | undefined): Promise<HttpTenant | undefined> {
        if (grant !== undefined) return (await grants.allows(grant, owner, path)) ? ownerTenant(owner) : undefined;
        const answer = await findTenant(request);
        return 'tenant' in answer && answer.tenant.instances.owner === owner ? answer.tenant : undefined;
    }

    /**
     * An uploaded file, `$.{owner}.apps.{app}.files.{file}`: whoever may open the app may read its files. The stored,
     * sniffed type with `nosniff` and the file policy; inline for pictures, audio and video, an attachment otherwise;
     * one byte range (`206`, `416`); immutable, with the bytes' SHA-256 as the `ETag` (`304`)
     */
    async function fileSource({ owner, app, file }: Readonly<Record<string, string>>, { request, response, head, grant }: PathRead): Promise<void> {
        if (owner === undefined || app === undefined || file === undefined || !isAppId(app) || !isAppId(file)) throw new HttpError(404, 'Not found', 'not_found');
        const tenant = await readerOf(request, owner, `${appFilesPattern(app)}.${file.toLowerCase()}`, grant);
        if (tenant === undefined || (await tenant.instances.find(app)) === undefined) throw new HttpError(404, 'Not found', 'not_found');
        let status = 200 as 200 | 206 | 304 | 416;
        let range: ByteRange | undefined;
        const result = await tenant.useCases.readFile.execute(app, file, (found) => {
            if (request.headers['if-none-match'] === `"${found.sha256}"`) {
                status = 304;
                return false;
            }
            const asked = byteRange(request.headers.range, found.size);
            if (asked === 'unsatisfiable') {
                status = 416;
                return false;
            }
            if (asked !== undefined) {
                status = 206;
                range = asked;
            }
            return head ? false : asked;
        });
        if (result.kind === 'not-found') throw new HttpError(404, 'Not found', 'not_found');
        const stored = result.file;
        const cache = { ETag: `"${stored.sha256}"`, 'Cache-Control': 'private, max-age=31536000, immutable' };
        if (status === 304) {
            response.writeHead(304, { ...COMMON_HEADERS, ...cache });
            response.end();
            return;
        }
        if (status === 416) {
            response.writeHead(416, { ...COMMON_HEADERS, 'Content-Range': `bytes */${stored.size}` });
            response.end();
            return;
        }
        const length = range === undefined ? stored.size : range.end - range.start + 1;
        response.writeHead(status, {
            'Content-Type': stored.type,
            'Content-Length': String(length),
            'Content-Disposition': `${INLINE_TYPE.test(stored.type) ? 'inline' : 'attachment'}; filename*=UTF-8''${dispositionName(stored.name)}`,
            'Content-Security-Policy': FILE_CSP,
            'Accept-Ranges': 'bytes',
            ...(range !== undefined && { 'Content-Range': `bytes ${range.start}-${range.end}/${stored.size}` }),
            ...cache,
            ...COMMON_HEADERS
        });
        if (result.kind === 'held') {
            response.end();
            return;
        }
        result.content.pipe(response);
    }

    /**
     * Releases a file (`fileRelease` of the runtime, through the host page). The host and same-origin checks of `handler`
     * apply, as to every method but GET and HEAD. A file the app's definition or live state still references stays: `409`
     */
    async function releaseRoute({ useCases }: HttpTenant, response: ServerResponse, appId: string, fileId: string): Promise<void> {
        if (!isAppId(fileId)) throw new HttpError(400, 'A file id is a UUID', 'invalid_id');
        const result = await useCases.releaseFile.execute(appId, fileId);
        switch (result.kind) {
            case 'released':
                response.writeHead(204, { ...COMMON_HEADERS, 'Cache-Control': 'no-store' });
                response.end();
                return;
            case 'referenced':
                throw new HttpError(409, 'The app or its live state still references this file', 'referenced');
            case 'not-found':
                throw new HttpError(404, 'No file with this id', 'not_found');
        }
    }

    const handler = (handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) => (request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
            try {
                if (!hostAllowed(request)) throw new HttpError(403, 'The Host header is not one this server answers to', 'forbidden_host');
                if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request) && !(request.method === 'POST' && options.crossOriginPost?.((request.url ?? '/').split('?')[0] as string) === true)) throw new HttpError(403, 'Cross-origin requests are refused', 'forbidden_origin');
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

    /**
     * For a view that may only look: a change is rejected at once (its path shows the authority's value again) and an
     * event is dropped. True when the frame was one of them, so it never reaches the authority
     */
    function refuseWrite(data: string | Uint8Array, refusals: SyncWire, ws: WebSocket): boolean {
        const type = wireTypeOf(data);
        if (type === 'emit') return true;
        if (type !== 'change') return false;
        // Every change of a read-only view comes here and none reaches the session, so this wire reads the paths
        // the view numbers; an ack carries no path, so its bytes are what the session's wire would write
        const read = refusals.read(data);
        if (read.ok && read.message.type === 'change' && ws.readyState === ws.OPEN) {
            ws.send(refusals.write({ type: 'ack', id: read.message.change.id, result: 'rejected', reason: 'This app is shared with you to look at only', code: 'access' }));
        }
        return true;
    }

    /** Refuses an upgrade with a plain HTTP answer and closes the socket */
    function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }

    /**
     * `GET /apps/:appId/sync`: the WebSocket of one view. The view joins the hub (document, commands, locale, theme and
     * deletion reach it as `{ type: 'view', message }` frames, the attach message first) and connects to the instance's
     * sync authority, which gets every other frame: its hello as text, then protocol 4's bytes. Closing the socket leaves both
     */
    async function syncUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        if (!hostAllowed(request)) return refuseUpgrade(socket, 403, 'Forbidden');
        // A browser always sends Origin with a WebSocket, so a page of another origin cannot open one
        if (!isSameOrigin(request)) return refuseUpgrade(socket, 403, 'Forbidden');
        const url = new URL(request.url ?? '/', 'http://localhost');
        const parts = url.pathname.split('/').filter((part) => part !== '');
        const appId = parts[1];
        const viewId = url.searchParams.get('view');
        if (parts.length !== 3 || parts[0] !== 'apps' || parts[2] !== 'sync' || appId === undefined || !isAppId(appId)) return refuseUpgrade(socket, 404, 'Not Found');
        if (!isUuid(viewId)) return refuseUpgrade(socket, 400, 'Bad Request');
        const answer = await findTenant(request);
        if ('revoked' in answer) {
            // Opened, so the view hears why: it deletes what it keeps of the app, and never reconnects
            const { message } = answer.revoked;
            sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
                ws.send(JSON.stringify({ type: 'error', code: REVOKED_CODE, message }));
                ws.close(1008, 'Revoked');
            });
            return;
        }
        if (!('tenant' in answer)) return refuseUpgrade(socket, answer.refuse, answer.refuse === 404 ? 'Not Found' : answer.refuse === 401 ? 'Unauthorized' : 'Forbidden');
        const { instances, liveViews, hub, retain, persona, reader } = answer.tenant;
        const readOnly = answer.tenant.access === 'view';
        const part = await instances.find(appId);
        if (part === undefined) return refuseUpgrade(socket, 404, 'Not Found');
        const first = await liveViews.attachMessage(appId);
        if (first === undefined) return refuseUpgrade(socket, 404, 'Not Found');
        // The view syncs with its persona's instance of the app (the owner's own unless the tenant names another), here
        // or on the server that runs it; the session is asked for once the socket is open
        sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
            const sendView = (message: ViewMessage): void => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'view', message }));
            };
            const connection: ViewConnection = { id: viewId, kind: url.searchParams.get('kind') === 'headless' ? 'headless' : 'browser', send: sendView };
            const detach = hub.attach(appId, connection);
            const release = retain?.((reason, revoked) => {
                if (revoked === true && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', code: REVOKED_CODE, message: reason }));
                ws.close(1008, reason.slice(0, 120));
            });
            sendView(first);
            let session: AuthoritySession | undefined;
            let closed = false;
            /** What the view sent before its session was ready, passed on in order once it is */
            const early: (string | Uint8Array)[] = [];
            const refusals = createSyncWire();
            instances
                .connect(part, persona ?? DEFAULT_PERSONA, {
                    send: (data) => {
                        if (ws.readyState === ws.OPEN) ws.send(data);
                    },
                    close: () => ws.close()
                })
                .then(
                    (made) => {
                        if (closed) return made.close();
                        session = made;
                        for (const data of early.splice(0)) made.receive(data);
                    },
                    (error: unknown) => {
                        report.info('Sync connection failed', { app: appId, error: error instanceof Error ? error.message : String(error) });
                        ws.close(1011, 'The app is not available');
                    }
                );
            const timer = setInterval(() => ws.ping(), KEEP_ALIVE_MS);
            // The view reads its files with a token that lasts minutes: a new one before it runs out, while the socket is open
            const renew = setInterval(() => {
                grants.issue(instances.owner, part.id, reader).then(
                    (grant) => sendView({ type: 'grant', grant }),
                    (error: unknown) => report.info('A /paths token was not signed', { app: appId, error: error instanceof Error ? error.message : String(error) })
                );
            }, PATH_TOKEN_RENEW_MS);
            const rate = options.socketMessagesPerSecond;
            // A token bucket: `rate` frames a second, at most twice that many at once
            let tokens = rate === undefined ? 0 : rate * 2;
            let filledAt = Date.now();
            ws.on('message', (data, isBinary) => {
                if (rate !== undefined) {
                    const now = Date.now();
                    tokens = Math.min(rate * 2, tokens + ((now - filledAt) / 1000) * rate);
                    filledAt = now;
                    if (tokens < 1) {
                        ws.close(1008, 'Too many messages');
                        return;
                    }
                    tokens -= 1;
                }
                hub.touch(appId, viewId);
                const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
                const frame = isBinary ? new Uint8Array(buffer) : buffer.toString('utf8');
                if (readOnly && refuseWrite(frame, refusals, ws)) return;
                if (session === undefined) early.push(frame);
                else session.receive(frame);
            });
            ws.on('error', () => ws.terminate());
            ws.on('close', () => {
                clearInterval(timer);
                clearInterval(renew);
                closed = true;
                session?.close();
                detach();
                release?.();
            });
        });
    }

    const listen = (target: Server, port: number, host = options.host): Promise<AddressInfo> =>
        new Promise<AddressInfo>((resolve, reject) => {
            target.once('error', reject);
            target.listen(port, host, () => {
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
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        socket.on('error', () => socket.destroy());
        syncUpgrade(request, socket, head).catch((error: unknown) => {
            report.info('Sync connection failed', { path: request.url?.split('?')[0], error: error instanceof Error ? error.message : String(error) });
            if (!socket.destroyed) refuseUpgrade(socket, 500, 'Internal Server Error');
        });
    };
    server.on('upgrade', upgrade);
    const servers: Server[] = [server, runtimeServer];
    const address = await listen(server, options.port);
    mainPort = address.port;
    try {
        runtimePort = (await listen(runtimeServer, options.runtimePort)).port;
    } catch (error) {
        await stop(server);
        throw error instanceof Error ? new Error(`The runtime port ${options.runtimePort}: ${error.message}`) : error;
    }
    const urlHost = (info: AddressInfo): string => (info.family === 'IPv6' ? `[${info.address}]` : info.address);
    let networkOrigin: string | undefined;
    if (options.network !== undefined) {
        // The same two ports on the network address, over TLS
        const tls = { key: options.network.key, cert: options.network.cert };
        const networkServer = createSecureServer(tls, handler(route)) as unknown as Server;
        const networkRuntime = createSecureServer(tls, handler(runtimeRoute)) as unknown as Server;
        networkServer.on('upgrade', upgrade);
        try {
            const at = await listen(networkServer, mainPort, options.network.host);
            servers.push(networkServer);
            await listen(networkRuntime, runtimePort, options.network.host);
            servers.push(networkRuntime);
            networkOrigin = `https://${urlHost(at)}:${at.port}`;
        } catch (error) {
            await Promise.all(servers.map(stop));
            throw error instanceof Error ? new Error(`The network address ${options.network.host}: ${error.message}`) : error;
        }
    }
    reportArea(PREVIEW_CATEGORY, 'View server listening', { port: address.port, runtimePort, network: networkOrigin !== undefined });
    return {
        origin: `http://${urlHost(address)}:${address.port}`,
        port: address.port,
        runtimePort,
        ...(networkOrigin !== undefined && { networkOrigin }),
        close: async () => {
            // Upgraded sockets are no longer the HTTP server's connections
            for (const client of sockets.clients) client.terminate();
            sockets.close();
            await Promise.all(servers.map(stop));
        }
    };
}
