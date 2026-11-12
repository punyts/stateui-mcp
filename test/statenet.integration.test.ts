import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStatenet } from '@punyts/statenet';
import type { RunningStatenet } from '@punyts/statenet';
import { chromium } from 'playwright';
import type { Browser, Frame, Page } from 'playwright';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/config/startServer.js';
import type { RunningServer } from '../src/config/startServer.js';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { EXPECTED_TOOLS } from './expectedTools.js';
import { call, createApp, silentReport, tempData } from './helpers.js';
import type { TempData } from './helpers.js';

const installed = await BrowserPreview.isInstalled();
const root = resolve(import.meta.dirname, '..');
const EMAIL = '$.screens.home.children.form.children.email';

async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read().catch(() => undefined as T);
        if (check(value) || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/** The runtime frame of a view page */
function frameOf(page: Page): Frame {
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error('no runtime frame');
    return frame;
}

/** The value of the email field the runtime frame draws, through its shadow root */
async function emailValue(page: Page): Promise<string | undefined> {
    return frameOf(page).evaluate(() => {
        const find = (root: ParentNode): HTMLInputElement | undefined => {
            for (const element of root.querySelectorAll('*')) {
                if (element instanceof HTMLInputElement) return element;
                if (element.shadowRoot !== null) {
                    const inner = find(element.shadowRoot);
                    if (inner !== undefined) return inner;
                }
            }
            return undefined;
        };
        return find(document.body)?.value;
    });
}

/**
 * The server with no web server of its own: the view page comes from the Vite dev server of view/ (with its plugin's
 * runtime origin), the state from a statenet, and the tools reach a page in Chromium only through the statenet
 */
describe.skipIf(!installed)('the live view through Vite and a statenet (Chromium through Playwright)', () => {
    let data: TempData;
    let vite: ViteDevServer;
    let viewUrl: string;
    let statenet: RunningStatenet;
    let server: RunningServer;
    let client: Client;
    let browser: Browser;
    let appId: string;

    beforeAll(async () => {
        data = await tempData();
        process.env['STATEUI_VIEW_RUNTIME_PORT'] = '0';
        vite = await createServer({ configFile: join(root, 'view/vite.config.ts'), server: { port: 0, strictPort: false }, logLevel: 'silent' });
        await vite.listen();
        viewUrl = vite.resolvedUrls?.local[0] ?? '';
        statenet = await startStatenet({ dataDir: join(data.dir, 'statenet'), port: 0, allowedOrigins: [new URL(viewUrl).origin] });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        server = await startServer({ dataDir: join(data.dir, 'mcp'), report: silentReport, statenetUrl: statenet.url, viewUrl, transport: serverTransport });
        client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(clientTransport);
        appId = (await createApp(client, 'contact')).id;
        browser = await chromium.launch();
    });

    afterAll(async () => {
        await browser?.close();
        await client?.close();
        await server?.stop();
        await statenet?.close();
        await vite?.close();
        delete process.env['STATEUI_VIEW_RUNTIME_PORT'];
        await data?.cleanup();
    });

    it('should render an app in the headless page that ui_preview opens on the view server', async () => {
        const preview = await call(client, 'ui_preview', { app: 'contact' });

        expect(preview.isError).toBe(false);
        expect(preview.body).toMatchObject({ rendered: true, errors: [] });
        expect(String(preview.body['url']).startsWith(viewUrl)).toBe(true);
        expect(String(preview.body['url'])).toContain(`app=${appId}`);
    });

    it("should show a tool's write in a person's page, and give the page's input to the tools", async () => {
        // Arrange: a person opens the address ui_preview gave
        const page = await browser.newPage();
        await page.goto(server.viewOf(appId));
        await page.waitForFunction(() => document.body.dataset['status'] === 'ready', undefined, { timeout: 15_000 });
        const runtimeOrigin = new URL(page.frames()[1]?.url() ?? 'http://none').origin;

        // Act: the agent writes, then the person types
        await call(client, 'ui_state_set', { app: 'contact', path: `${EMAIL}.value`, value: 'agent@example.com' });
        const shown = await eventually(() => emailValue(page), (value) => value === 'agent@example.com');
        await frameOf(page).locator('input').first().fill('person@example.com');
        const read = await eventually(
            async () => (await call(client, 'ui_state_get', { app: 'contact', path: `${EMAIL}.value` })).body['value'],
            (value) => value === 'person@example.com'
        );
        await page.close();

        // Assert: the frame has an origin of its own, and both writes went through the statenet
        expect(runtimeOrigin).not.toBe(new URL(viewUrl).origin);
        expect(shown).toBe('agent@example.com');
        expect(read).toBe('person@example.com');
    });

    it("should read a page's events and take screenshots and clicks through the headless page", async () => {
        const interacted = await call(client, 'ui_interact', { app: 'contact', actions: [{ action: 'click', path: '$.screens.home.children.form.children.save' }] });
        const events = await eventually(
            async () => (await call(client, 'ui_events_read', { app: 'contact' })).body['events'] as { name: string; view: string }[],
            (value) => Array.isArray(value) && value.some((event) => event.name === 'form.saved')
        );
        const shot = await call(client, 'ui_screenshot', { app: 'contact' });

        expect(interacted.isError).toBe(false);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'form.saved', view: 'headless' })]));
        expect(shot.images[0]?.mimeType).toBe('image/png');
    });

    it('should list the apps on the view page without an app', async () => {
        const page = await browser.newPage();
        await page.goto(`${viewUrl}?statenet=${encodeURIComponent(statenet.url)}`);
        const text = await eventually(() => page.locator('body').innerText(), (value) => typeof value === 'string' && value.includes('contact'));
        await page.close();

        expect(text).toContain('contact');
    });
});

describe('the stateui-mcp command', () => {
    it('should speak MCP on stdio and listen on no port', async () => {
        const data = await tempData();
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(root, 'dist/cli.js'), '--data-dir', data.dir, '--no-showcase', '--statenet', 'ws://127.0.0.1:9/sync'],
            stderr: 'pipe'
        });
        const client = new Client({ name: 'test', version: '1.0.0' });
        try {
            await client.connect(transport);
            const tools = await client.listTools();
            const created = await call(client, 'ui_app_create', { name: 'offline' });

            // The statenet is not there: the tools still work, and the views catch up once it is
            expect(tools.tools.length).toBe(EXPECTED_TOOLS.length);
            expect(created.isError).toBe(false);
        } finally {
            await client.close();
            await data.cleanup();
        }
    });
});
