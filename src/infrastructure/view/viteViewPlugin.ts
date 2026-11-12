import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Plugin, ViteDevServer } from 'vite';
import { PAGE_CSS } from '../http/pages.js';
import { loadChunk3d, loadRuntimeBundle, RUNTIME_CSS, runtimePage } from '../http/runtimeBundle.js';
import type { RuntimeBundle, RuntimeChunk } from '../http/runtimeBundle.js';
import { COMMON_HEADERS, requestHostName, runtimeCsp } from '../http/security.js';
import { loadCatalogFile } from '../stateUiLibrary.js';

/** The runtime frame's page, under the runtime origin and in a build */
export const RUNTIME_PAGE_PATH = '/runtime/runtime.html';

export interface StateUiViewPluginOptions {
    /** The folder of the built runtime bundle; default the one in `@punyts/stateui-app` */
    readonly runtimeDir?: string;
    /** The folder of the built 3D chunk; default the one in `@punyts/stateui-3d` when it is installed */
    readonly chunk3dDir?: string;
    /** The dev server's port for the runtime frame, a second origin; default the page's port plus one */
    readonly runtimePort?: number;
    /**
     * Where the pages load the runtime frame from instead of the dev server's runtime port, such as a CDN origin
     * (`https://runtime.example.com/runtime/runtime.html`); `{host}` stands for the page's host name. A build without
     * it loads `./runtime/runtime.html` beside the page, which shares the page's origin
     */
    readonly runtimeUrl?: string;
}

/**
 * The Vite plugin of the statenet view page (`view/`): it serves what the page needs beside its own module, and puts it
 * into a build.
 *
 * - In the dev server, the runtime frame (the page of `@punyts/stateui-app`'s runtime bundle, the bundle and the 3D
 *   chunk) on a second port, so the sandboxed frame keeps an origin of its own and cannot reach the page, under the
 *   runtime policy (no network, framed by the page's origin only); and `/page.css`.
 * - In a build, `runtime/` and `page.css` beside the pages, for a CDN.
 * - The page's body gets `data-runtime-url` and `data-chunk-3d`, which `src/browser/statenetView.ts` reads.
 */
export function stateuiView(options: StateUiViewPluginOptions = {}): Plugin {
    let runtime: RuntimeBundle | undefined;
    let chunk3d: RuntimeChunk | undefined;
    let runtimeServer: Server | undefined;
    let runtimePort = 0;
    let pagePort = 0;
    let building = false;
    const load = (): void => {
        if (runtime !== undefined) return;
        runtime = loadRuntimeBundle(options.runtimeDir, loadCatalogFile().components.map((component) => component.name));
        chunk3d = loadChunk3d(options.chunk3dDir);
    };
    const runtimeUrl = (): string => {
        if (options.runtimeUrl !== undefined) return options.runtimeUrl;
        if (building) return `.${RUNTIME_PAGE_PATH}`;
        return `http://{host}:${runtimePort}${RUNTIME_PAGE_PATH}`;
    };
    const send = (response: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { 'Content-Type': type, ...COMMON_HEADERS, ...headers });
        response.end(body);
    };
    /** The runtime origin: the frame's page, its stylesheet, the bundle and the 3D chunk, and nothing else */
    const serveRuntime = (request: IncomingMessage, response: ServerResponse): void => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        const bundle = runtime as RuntimeBundle;
        const host = requestHostName(request.headers.host);
        if (request.method !== 'GET' || host === undefined) return send(response, 404, 'text/plain', 'Not found');
        if (path === RUNTIME_PAGE_PATH) {
            return send(response, 200, 'text/html; charset=utf-8', runtimePage(bundle.hash), {
                'Content-Security-Policy': runtimeCsp(`http://${host}:${pagePort}`),
                'Cache-Control': 'no-cache'
            });
        }
        if (path === '/runtime/runtime.css') return send(response, 200, 'text/css; charset=utf-8', RUNTIME_CSS, { 'Cache-Control': 'no-cache' });
        for (const script of [bundle, chunk3d]) {
            if (script !== undefined && path === `/runtime/${script.hash}.js`) {
                return send(response, 200, 'text/javascript; charset=utf-8', script.script, { 'Cache-Control': 'public, max-age=31536000, immutable' });
            }
        }
        send(response, 404, 'text/plain', 'Not found');
    };
    const startRuntime = async (server: ViteDevServer): Promise<void> => {
        const address = server.httpServer?.address();
        if (address === null || address === undefined || typeof address === 'string') return;
        pagePort = address.port;
        const host = server.config.server.host;
        runtimeServer = createServer(serveRuntime);
        const listening = runtimeServer;
        await new Promise<void>((resolve, reject) => {
            listening.once('error', reject);
            listening.listen(options.runtimePort ?? pagePort + 1, typeof host === 'string' ? host : '127.0.0.1', () => resolve());
        });
        runtimePort = (listening.address() as AddressInfo).port;
        server.config.logger.info(`  stateui runtime frame: http://${typeof host === 'string' ? host : '127.0.0.1'}:${runtimePort}${RUNTIME_PAGE_PATH}`);
    };
    return {
        name: 'stateui-view',
        configResolved(config) {
            building = config.command === 'build';
        },
        configureServer(server) {
            load();
            server.middlewares.use((request, response, next) => {
                if (request.url?.split('?')[0] === '/page.css') return send(response, 200, 'text/css; charset=utf-8', PAGE_CSS, { 'Cache-Control': 'no-cache' });
                next();
            });
            server.httpServer?.once('listening', () => {
                startRuntime(server).catch((error: unknown) => server.config.logger.error(`stateui runtime frame: ${error instanceof Error ? error.message : String(error)}`));
            });
            server.httpServer?.once('close', () => runtimeServer?.close());
        },
        buildStart() {
            if (building) load();
        },
        transformIndexHtml(html) {
            load();
            const attributes = [`data-runtime-url="${runtimeUrl()}"`, ...(chunk3d === undefined ? [] : [`data-chunk-3d="${chunk3d.hash}"`])].join(' ');
            return html.replace(/<body([^>]*)>/, `<body$1 ${attributes}>`);
        },
        generateBundle() {
            const bundle = runtime as RuntimeBundle;
            this.emitFile({ type: 'asset', fileName: 'page.css', source: PAGE_CSS });
            this.emitFile({ type: 'asset', fileName: 'runtime/runtime.html', source: runtimePage(bundle.hash) });
            this.emitFile({ type: 'asset', fileName: 'runtime/runtime.css', source: RUNTIME_CSS });
            this.emitFile({ type: 'asset', fileName: `runtime/${bundle.hash}.js`, source: bundle.script });
            if (chunk3d !== undefined) this.emitFile({ type: 'asset', fileName: `runtime/${chunk3d.hash}.js`, source: chunk3d.script });
        }
    };
}
