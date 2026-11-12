import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { packageRoot } from '../infrastructure/http/packageRoot.js';
import { createStateUiMcpServer } from '../infrastructure/mcp/StateUiMcpServer.js';
import type { PreviewBrowser } from '../infrastructure/preview/BrowserPreview.js';
import { StatenetViews } from '../infrastructure/statenet/StatenetViews.js';
import { createServices } from './createServices.js';
import { installShowcase } from './showcase.js';
import type { ServicesOptions } from './createServices.js';
import type { Services } from './createServices.js';

/** The statenet a server uses unless told otherwise */
export const DEFAULT_STATENET_URL = 'ws://127.0.0.1:4200/sync';
/** The view page (the Vite dev server of `view/`) a server names unless told otherwise */
export const DEFAULT_VIEW_URL = 'http://127.0.0.1:5180/';

export interface ServerOptions {
    readonly dataDir: string;
    readonly report: UseCaseReport;
    /** The statenet's WebSocket, which the server writes the apps' state to and the pages read it from; default `DEFAULT_STATENET_URL` */
    readonly statenetUrl?: string;
    /**
     * The view page: the Vite dev server locally, a CDN in production; default `DEFAULT_VIEW_URL`. An app's view is
     * `<viewUrl>?app=<id>&statenet=<statenetUrl>`, the address `ui_preview` gives and the headless browser opens
     */
    readonly viewUrl?: string;
    /**
     * The MCP transport: stdio by default (`'stdio'`), none (`'none'`, for a test that connects its own), or one given.
     * The server never listens on a port
     */
    readonly transport?: 'stdio' | 'none' | Transport;
    /** Replaces the Playwright browser, for tests */
    readonly browser?: PreviewBrowser;
    /** Extra arguments for the headless Chromium, for tests (none by default) */
    readonly browserArgs?: readonly string[];
    /** The key that encrypts `$.server` at rest */
    readonly serverKey?: Uint8Array;
    /** The server procedures Full-mode logic `call`s by name; other names wait for the agent (`ui_call_answer`) */
    readonly procedures?: ServicesOptions['procedures'];
    /**
     * The compute, expression and effect functions Full-mode logic runs by name: one module the browser host
     * (`mountApp`'s `logicFunctions`) shares. API keys an effect needs stay on the server
     */
    readonly logicFunctions?: ServicesOptions['logicFunctions'];
    /** A file that gets one JSON line per tool call */
    readonly toolLog?: string;
    /** Install the component showcase when the data directory holds no parts at all (the CLI does, unless --no-showcase); default false */
    readonly showcase?: boolean;
}

export interface RunningServer {
    readonly statenetUrl: string;
    readonly viewUrl: string;
    readonly services: Services;
    /** The server's side of the live views in the statenet */
    readonly views: StatenetViews;
    /** The page of an app's live view */
    viewOf(appId: string): string;
    /** Closes the MCP transport, the statenet connections and the headless browser. Safe to call twice */
    stop(): Promise<void>;
}

/** The compiled host script of a page that its own server serves (`startHttpServer`'s `/assets/host.js`) */
export function loadHostScript(): Buffer {
    const path = join(packageRoot(), 'dist', 'browser', 'host.js');
    if (!existsSync(path)) throw new Error('The browser host script is not built. Run "npm run build" first');
    return readFileSync(path);
}

/** `<viewUrl>?app=<id>&statenet=<url>`, keeping any query the view URL has */
export function statenetViewPage(viewUrl: string, statenetUrl: string, appId: string): string {
    const url = new URL(viewUrl);
    url.searchParams.set('app', appId);
    url.searchParams.set('statenet', statenetUrl);
    return url.href;
}

/**
 * Starts the MCP server. It serves no HTTP: the tools write the apps' state through the statenet (`StatenetViews`),
 * which the view pages (served by Vite locally, a CDN in production) connect to
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
    const statenetUrl = options.statenetUrl ?? DEFAULT_STATENET_URL;
    const viewUrl = options.viewUrl ?? DEFAULT_VIEW_URL;
    const viewOf = (appId: string): string => statenetViewPage(viewUrl, statenetUrl, appId);
    // Before anything reads a part: a new data directory gets the showcase app
    if (options.showcase === true) await installShowcase({ dataDir: options.dataDir, report: options.report });
    const services = createServices({
        dataDir: options.dataDir,
        report: options.report,
        origin: () => new URL(viewUrl).origin,
        viewPage: viewOf,
        ...(options.browser !== undefined && { browser: options.browser }),
        ...(options.browserArgs !== undefined && { browserArgs: options.browserArgs }),
        ...(options.serverKey !== undefined && { serverKey: options.serverKey }),
        ...(options.procedures !== undefined && { procedures: options.procedures }),
        ...(options.logicFunctions !== undefined && { logicFunctions: options.logicFunctions }),
        ...(options.toolLog !== undefined && { toolLog: options.toolLog })
    });
    // A rename stopped halfway by a crash is finished before anything reads a part
    if (await services.recoverParts()) options.report.info('Finished a part rename that was stopped halfway', {});
    const views = new StatenetViews(services, { url: statenetUrl, report: options.report });
    views.start();

    const choice = options.transport ?? 'stdio';
    const mcp = choice === 'none' ? undefined : createStateUiMcpServer({ ...services, useCases: services.useCases });
    if (mcp !== undefined) await mcp.connect(typeof choice === 'string' ? new StdioServerTransport() : choice);
    options.report.info('Server started', { statenet: statenetUrl, view: viewUrl, dataDir: options.dataDir });

    let stopped = false;
    return {
        statenetUrl,
        viewUrl,
        services,
        views,
        viewOf,
        stop: async () => {
            if (stopped) return;
            stopped = true;
            if (mcp !== undefined) await mcp.close().catch(() => undefined);
            await views.close();
            await services.browser.close();
            await services.authorities.close();
        }
    };
}
