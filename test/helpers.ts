import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServices } from '../src/config/createServices.js';
import type { Services } from '../src/config/createServices.js';
import { startServer } from '../src/config/startServer.js';
import type { RunningServer, ServerOptions } from '../src/config/startServer.js';
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

export interface HttpHarness {
    readonly server: RunningServer;
    readonly client: Client;
    close(): Promise<void>;
}
/** The whole server on a free port (or `extra.port`) with a real MCP client over streamable HTTP; `extra` sets a port, a key or the 3D chunk folder */
export async function httpHarness(dataDir: string, browser?: PreviewBrowser, extra: Partial<Pick<ServerOptions, 'port' | 'runtimePort' | 'serverKey' | 'chunk3dDir'>> = {}): Promise<HttpHarness> {
    const server = await startServer({
        dataDir,
        host: '127.0.0.1',
        port: 0,
        stdio: false,
        report: silentReport,
        ...(browser !== undefined && { browser }),
        ...extra
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`)));
    return {
        server,
        client,
        close: async () => {
            await client.close();
            await server.stop();
        }
    };
}

/** The shell of the form app: a form with an email field and a Save button that emits, and the outlet every shell needs */
export const FORM_SHELL = Object.freeze({
    component: 'page',
    children: Object.freeze({
        form: Object.freeze({
            component: 'panel',
            children: Object.freeze({
                email: Object.freeze({ component: 'textField', _label: 'Email' }),
                save: Object.freeze({ component: 'button', _title: 'Save', on: Object.freeze({ press: Object.freeze({ command: 'emit', target: 'form.saved', value: 'ok' }) }) })
            })
        }),
        main: Object.freeze({ component: 'outlet' })
    })
});

/** The shell of a test app from the nodes under its page: they come first and the outlet last */
export function shellOf(children: Record<string, unknown>): Record<string, unknown> {
    return { component: 'page', children: { ...children, main: { component: 'outlet' } } };
}

export interface CreatedApp {
    /** The app's name, which the run-time tools take as `app` */
    readonly name: string;
    /** The part id, which names the view `/apps/<id>` */
    readonly id: string;
}

/** Creates an app part with `ui_app_create`, or throws with the answer */
export async function createApp(client: Client, name: string, shell: object = FORM_SHELL, extra: Record<string, unknown> = {}): Promise<CreatedApp> {
    const created = await call(client, 'ui_app_create', { name, shell, ...extra });
    if (created.isError) throw new Error(`ui_app_create ${name}: ${JSON.stringify(created.body)}`);
    return { name, id: created.body['id'] as string };
}
