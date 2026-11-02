import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { startHttpServer } from '../infrastructure/http/HttpServer.js';
import { packageRoot } from '../infrastructure/http/packageRoot.js';
import { loadRuntimeBundle } from '../infrastructure/http/runtimeBundle.js';
import { McpHttpSessions } from '../infrastructure/mcp/McpHttpSessions.js';
import { createStateUiMcpServer } from '../infrastructure/mcp/StateUiMcpServer.js';
import type { PreviewBrowser } from '../infrastructure/preview/BrowserPreview.js';
import { createServices } from './createServices.js';
import type { Services } from './createServices.js';

export interface ServerOptions {
    readonly dataDir: string;
    readonly host: string;
    /** 0 picks a free port */
    readonly port: number;
    /** The port of the runtime origin that serves the app frame; default the next port after `port` (a free one when `port` is 0) */
    readonly runtimePort?: number;
    /** Speak MCP over stdin and stdout as well. The HTTP server still listens, so the browser view works */
    readonly stdio: boolean;
    readonly report: UseCaseReport;
    /** The folder of the built runtime bundle; default is the one in `@punyts/stateui-app` */
    readonly runtimeDir?: string;
    /** Replaces the Playwright browser, for tests */
    readonly browser?: PreviewBrowser;
}

export interface RunningServer {
    readonly origin: string;
    readonly port: number;
    readonly runtimePort: number;
    readonly services: Services;
    readonly sessions: McpHttpSessions;
    /** Closes the MCP sessions, the HTTP server and the headless browser. Safe to call twice */
    stop(): Promise<void>;
}

function loadHostScript(): Buffer {
    const path = join(packageRoot(), 'dist', 'browser', 'host.js');
    if (!existsSync(path)) throw new Error('The browser host script is not built. Run "npm run build" first');
    return readFileSync(path);
}

/** Starts the HTTP server (MCP at /mcp and the browser endpoint), and the stdio transport when asked */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
    const runtime = loadRuntimeBundle(options.runtimeDir);
    const hostScript = loadHostScript();
    let origin = '';
    const services = createServices({
        dataDir: options.dataDir,
        report: options.report,
        origin: () => origin,
        ...(options.browser !== undefined && { browser: options.browser })
    });
    const dependencies = { ...services, useCases: services.useCases };
    const sessions = new McpHttpSessions(() => createStateUiMcpServer(dependencies), options.report);
    const http = await startHttpServer({
        host: options.host,
        port: options.port,
        runtimePort: options.runtimePort ?? (options.port === 0 ? 0 : options.port + 1),
        useCases: services.useCases,
        repository: services.repository,
        hub: services.hub,
        authorities: services.authorities,
        liveViews: services.liveViews,
        mcp: sessions,
        runtime,
        hostScript,
        report: options.report
    });
    origin = http.origin.replace('//0.0.0.0', '//127.0.0.1').replace('//[::]', '//[::1]');

    const stdioServer = options.stdio ? createStateUiMcpServer(dependencies) : undefined;
    if (stdioServer !== undefined) await stdioServer.connect(new StdioServerTransport());
    options.report.info('Server started', { origin, stdio: options.stdio, dataDir: options.dataDir });

    let stopped = false;
    return {
        origin,
        port: http.port,
        runtimePort: http.runtimePort,
        services,
        sessions,
        stop: async () => {
            if (stopped) return;
            stopped = true;
            await sessions.close();
            if (stdioServer !== undefined) await stdioServer.close().catch(() => undefined);
            await services.browser.close();
            await http.close();
            await services.authorities.close();
        }
    };
}
