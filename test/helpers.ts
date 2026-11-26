import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServices } from '../src/config/createServices.js';
import type { Services } from '../src/config/createServices.js';
import { installShowcase } from '../src/config/showcase.js';
import { loadHostScript } from '../src/config/startServer.js';
import { startHttpServer } from '../src/infrastructure/http/HttpServer.js';
import type { HttpServerOptions } from '../src/infrastructure/http/HttpServer.js';
import { loadChunk3d, loadRuntimeBundle } from '../src/infrastructure/http/runtimeBundle.js';
import { loadCatalogFile } from '../src/infrastructure/stateUiLibrary.js';
import { createStateUiMcpServer } from '../src/infrastructure/mcp/StateUiMcpServer.js';
import type { PreviewBrowser } from '../src/infrastructure/preview/BrowserPreview.js';

/** A reporter that says nothing: tests read results, not logs */
export const silentReport = { info: (): void => undefined };

export interface ToolResult {
    readonly isError: boolean;
    readonly body: Record<string, unknown>;
    readonly images: readonly { data: string; mimeType: string }[];
}

type CallResult = Awaited<ReturnType<Client['callTool']>>;

/** The JSON text of a tool result and its images, as the tools write them */
export function readResult(result: CallResult): ToolResult {
    const content = (result.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
    const text = content.find((item) => item.type === 'text')?.text ?? '{}';
    return {
        isError: result['isError'] === true,
        body: JSON.parse(text) as Record<string, unknown>,
        images: content.filter((item) => item.type === 'image').map((item) => ({ data: item.data ?? '', mimeType: item.mimeType ?? '' }))
    };
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return readResult(await client.callTool({ name, arguments: args }));
}

export interface TempData {
    readonly dir: string;
    cleanup(): Promise<void>;
}

export async function tempData(): Promise<TempData> {
    const dir = await mkdtemp(join(tmpdir(), 'stateui-mcp-test-'));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A browser that is never started: the tools that need one fail in a way the test can read */
export const noBrowser: PreviewBrowser = {
    open: async () => ({ rendered: false }),
    screenshot: async () => {
        throw new Error('no browser in this test');
    },
    interact: async () => {
        throw new Error('no browser in this test');
    },
    rendered: async () => {
        throw new Error('no browser in this test');
    },
    closePage: async () => undefined,
    close: async () => undefined
};

export interface InMemoryHarness {
    readonly client: Client;
    readonly services: Services;
    close(): Promise<void>;
}

/** The real tools, use cases and file storage, with an in-memory MCP client and a stand-in browser */
/** `toolLog` turns the tool-call log on, writing to that file */
export async function inMemoryHarness(dataDir: string, browser: PreviewBrowser = noBrowser, toolLog?: string): Promise<InMemoryHarness> {
    const services = createServices({ dataDir, report: silentReport, origin: () => 'http://127.0.0.1:4100', browser, ...(toolLog !== undefined && { toolLog }) });
    const server = createStateUiMcpServer(services);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
        client,
        services,
        close: async () => {
            await client.close();
            await server.close();
            await services.authorities.close();
        }
    };
}

/** The embedded browser endpoint the harness runs, shaped as the server the tests read */
export interface EmbeddedServer {
    readonly origin: string;
    readonly port: number;
    readonly runtimePort: number;
    readonly services: Services;
    stop(): Promise<void>;
}

export interface HttpHarness {
    readonly server: EmbeddedServer;
    readonly client: Client;
    close(): Promise<void>;
}

export interface HttpHarnessOptions {
    readonly port?: number;
    readonly runtimePort?: number;
    readonly serverKey?: Uint8Array;
    /** The folder of the 3D chunk the endpoint serves; default the installed one */
    readonly chunk3dDir?: string;
    readonly browserArgs?: readonly string[];
    readonly showcase?: boolean;
    readonly routes?: HttpServerOptions['routes'];
    readonly crossOriginPost?: HttpServerOptions['crossOriginPost'];
    readonly publicOrigins?: HttpServerOptions['publicOrigins'];
    /** What the one tenant may do with the apps: the owner's by default */
    readonly access?: 'owner' | 'use' | 'view';
}

/**
 * The tools with the browser endpoint that serves its own view pages (`startHttpServer`, what an embedding server such
 * as Magnetic runs) on a free port (or `extra.port`), and an MCP client in memory. The stateui-mcp server itself serves
 * no HTTP (its views live in a statenet: `statenet.integration.test.ts`); the tests of what a view renders and does
 * run here, since the view behaves the same over either channel
 */
export async function httpHarness(dataDir: string, browser?: PreviewBrowser, extra: HttpHarnessOptions = {}): Promise<HttpHarness> {
    if (extra.showcase === true) await installShowcase({ dataDir, report: silentReport });
    let origin = '';
    const services = createServices({
        dataDir,
        report: silentReport,
        origin: () => origin,
        ...(browser !== undefined && { browser }),
        ...(extra.browserArgs !== undefined && { browserArgs: extra.browserArgs }),
        ...(extra.serverKey !== undefined && { serverKey: extra.serverKey })
    });
    await services.recoverParts();
    const chunk3d = loadChunk3d(extra.chunk3dDir);
    const http = await startHttpServer({
        host: '127.0.0.1',
        port: extra.port ?? 0,
        runtimePort: extra.runtimePort ?? 0,
        tenant: { useCases: services.useCases, hub: services.hub, liveViews: services.liveViews, instances: services.instanceViews, ...(extra.access !== undefined && { access: extra.access }) },
        runtime: loadRuntimeBundle(undefined, loadCatalogFile().components.map((component) => component.name)),
        ...(chunk3d !== undefined && { chunk3d }),
        hostScript: loadHostScript(),
        report: silentReport,
        ...(extra.routes !== undefined && { routes: extra.routes }),
        ...(extra.crossOriginPost !== undefined && { crossOriginPost: extra.crossOriginPost }),
        ...(extra.publicOrigins !== undefined && { publicOrigins: extra.publicOrigins })
    });
    origin = http.origin;
    const mcp = createStateUiMcpServer(services);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    let stopped = false;
    const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        await mcp.close().catch(() => undefined);
        await services.browser.close();
        await http.close();
        await services.authorities.close();
    };
    return {
        server: { origin, port: http.port, runtimePort: http.runtimePort, services, stop },
        client,
        close: async () => {
            await client.close();
            await stop();
        }
    };
}

/** The home screen root of the form app: a form with an email field and a Save button the host is told of (`@id` save) */
export const FORM_ROOT = Object.freeze({
    component: 'panel',
    children: Object.freeze({
        form: Object.freeze({
            component: 'panel',
            children: Object.freeze({
                email: Object.freeze({ component: 'textField', _label: 'Email' }),
                save: Object.freeze({ component: 'button', _title: 'Save', '@id': 'save' })
            })
        })
    })
});

/** The home screen root of a test app: a panel holding the nodes */
export function rootOf(children: Record<string, unknown>): Record<string, unknown> {
    return { component: 'panel', children };
}

/** The path of a node of the home screen root: `HOME` plus `.children.form` */
export const HOME = '$.screens.home';

export interface CreatedApp {
    /** The app's name, which the run-time tools take as `app` */
    readonly name: string;
    /** The part id, which names the view `/apps/<id>` */
    readonly id: string;
}

/** Creates an app part with `ui_app_create`, or throws with the answer */
export async function createApp(client: Client, name: string, home: object = FORM_ROOT, extra: Record<string, unknown> = {}): Promise<CreatedApp> {
    const created = await call(client, 'ui_app_create', { name, home, ...extra });
    if (created.isError) throw new Error(`ui_app_create ${name}: ${JSON.stringify(created.body)}`);
    return { name, id: created.body['id'] as string };
}

/** The `/paths` URL of a file of an app on a harness's server */
export function filePathOf(server: { readonly origin: string; readonly services: { readonly instanceViews: { readonly owner: string } } }, appId: string, fileId: string): string {
    return `${server.origin}/paths/${server.services.instanceViews.owner}/apps/${appId.toLowerCase()}/files/${fileId}`;
}
