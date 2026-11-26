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

    it('should run a server rule on every press of a button that sets a value its path already holds', async () => {
        // Arrange: Save sets its own busy to false, which it already is; a rule on the server emits on that path
        const save = '$.screens.home.children.press';
        const created = await call(client, 'ui_app_create', {
            name: 'presses',
            home: { component: 'panel', children: { press: { component: 'button', _title: 'Save', on: { press: { command: 'set', target: '.busy', value: false } } } } }
        });
        const rule = await call(client, 'ui_logic_write', {
            app: 'presses',
            expectedRevision: 1,
            operations: [{ op: 'set', unit: 'rules.pressed', value: { when: { path: `${save}.busy` }, do: [{ command: 'emit', target: 'save.pressed' }] } }]
        });
        const id = created.body['id'] as string;
        const page = await browser.newPage();
        await page.goto(server.viewOf(id));
        await page.waitForFunction(() => document.body.dataset['status'] === 'ready', undefined, { timeout: 15_000 });
        await page.waitForFunction(() => document.body.dataset['sync'] === 'online');

        // Act: a person presses three times
        for (let press = 0; press < 3; press++) {
            await frameOf(page).locator('button').first().click();
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        const pressed = await eventually(
            async () => ((await call(client, 'ui_events_read', { app: 'presses' })).body['events'] as { name: string }[]).filter((event) => event.name === 'save.pressed'),
            (events) => Array.isArray(events) && events.length >= 3
        );
        await page.close();

        // Assert
        expect([created.isError, rule.isError]).toEqual([false, false]);
        expect(pressed).toHaveLength(3);
    });

    it("should run a server rule on every press of a plain button, through its transient pressed, with no on command", async () => {
        // Arrange: a button with nothing wired; the rule watches its pressed
        const button = '$.screens.home.children.go';
        const created = await call(client, 'ui_app_create', { name: 'clicks', home: { component: 'panel', children: { go: { component: 'button', _title: 'Go' } } } });
        const rule = await call(client, 'ui_logic_write', {
            app: 'clicks',
            expectedRevision: 1,
            operations: [{ op: 'set', unit: 'rules.go', value: { when: { path: `${button}.pressed` }, do: [{ command: 'emit', target: 'go.clicked' }] } }]
        });
        const page = await browser.newPage();
        await page.goto(server.viewOf(created.body['id'] as string));
        await page.waitForFunction(() => document.body.dataset['status'] === 'ready' && document.body.dataset['sync'] === 'online', undefined, { timeout: 15_000 });

        // Act
        for (let press = 0; press < 3; press++) {
            await frameOf(page).locator('button').first().click();
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        const clicked = await eventually(
            async () => ((await call(client, 'ui_events_read', { app: 'clicks' })).body['events'] as { name: string }[]).filter((event) => event.name === 'go.clicked'),
            (events) => Array.isArray(events) && events.length >= 3
        );
        const state = await call(client, 'ui_state_get', { app: 'clicks', path: `${button}.pressed` });
        await page.close();

        // Assert
        expect([created.isError, rule.isError]).toEqual([false, false]);
        expect(clicked).toHaveLength(3);
        expect(state.body['value']).toMatchObject({ at: expect.any(Number), device: expect.any(String) });
    });

    it("should run a server rule on every press of a card through $.raised, and on a shape's hover only when a rule uses it", async () => {
        // Arrange: a card and a drawing with one interactive circle; rules on the card's press and, later, the circle's hover
        const card = '$.screens.home.children.card';
        const dot = '$.screens.home.children.map.children.dot';
        const created = await call(client, 'ui_app_create', {
            name: 'raised',
            home: {
                component: 'panel',
                children: {
                    card: { component: 'card', _title: 'Open me', interactive: true },
                    map: {
                        component: 'drawing',
                        _title: 'Map',
                        viewBox: { x: 0, y: 0, width: 200, height: 100 },
                        children: { dot: { component: 'circle', cx: 100, cy: 50, r: 30, fill: '#ff0000', interactive: true, _label: 'Dot' } }
                    }
                }
            }
        });
        const pressRule = await call(client, 'ui_logic_write', {
            app: 'raised',
            expectedRevision: 1,
            operations: [{ op: 'set', unit: 'rules.opened', value: { when: { path: `$.raised.${card.slice(2)}.press` }, do: [{ command: 'emit', target: 'card.pressed' }] } }]
        });
        const events = async (name: string): Promise<unknown[]> =>
            ((await call(client, 'ui_events_read', { app: 'raised' })).body['events'] as { name: string }[]).filter((event) => event.name === name);

        // Act: press the card twice, and hover the dot while no rule uses hover
        await call(client, 'ui_preview', { app: 'raised' });
        for (let press = 0; press < 2; press++) await call(client, 'ui_interact', { app: 'raised', actions: [{ action: 'click', path: card }] });
        const pressed = await eventually(() => events('card.pressed'), (value) => Array.isArray(value) && value.length >= 2);
        await call(client, 'ui_interact', { app: 'raised', actions: [{ action: 'hover', path: dot }] });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const unused = (await call(client, 'ui_state_get', { app: 'raised', path: `$.raised.${dot.slice(2)}` })).body;

        // ...then with a rule on the dot's hover (the page loads again with the new logic)
        const hoverRule = await call(client, 'ui_logic_write', {
            app: 'raised',
            expectedRevision: 2,
            operations: [{ op: 'set', unit: 'rules.looked', value: { when: { path: `$.raised.${dot.slice(2)}.hover` }, do: [{ command: 'emit', target: 'dot.hovered' }] } }]
        });
        await call(client, 'ui_preview', { app: 'raised' });
        await call(client, 'ui_interact', { app: 'raised', actions: [{ action: 'hover', path: card }, { action: 'hover', path: dot }] });
        const hovered = await eventually(() => events('dot.hovered'), (value) => Array.isArray(value) && value.length >= 1);
        // Writing raised into the shape redraws it: that must not make it raise hover again and again
        const settled = await eventually(() => events('dot.hovered'), () => false, 2000);

        // Assert
        expect([created.isError, pressRule.isError, hoverRule.isError]).toEqual([false, false, false]);
        // The raised paths are ordinary trigger paths: nothing warns about them
        expect(JSON.stringify([pressRule.body['warnings'], hoverRule.body['warnings']])).not.toContain('.raised.');
        expect(pressed).toHaveLength(2);
        expect(unused['error']).toBe('unknown-path');
        // One hover at once and, the pointer still moving over the dot, at most the last one when the 250 ms window ends
        expect(hovered.length).toBeGreaterThanOrEqual(1);
        expect(settled.length).toBeLessThanOrEqual(2);
    });

    it('should run a server rule on every tool write of the value a path already holds', async () => {
        const path = '$.screens.home.children.press.busy';
        await call(client, 'ui_logic_write', {
            app: 'presses',
            expectedRevision: 2,
            operations: [{ op: 'set', unit: 'rules.pressed', value: { when: { path }, do: [{ command: 'emit', target: 'tool.wrote' }] } }]
        });

        for (let write = 0; write < 2; write++) await call(client, 'ui_state_set', { app: 'presses', path, value: true });
        const events = (await call(client, 'ui_events_read', { app: 'presses' })).body['events'] as { name: string }[];

        expect(events.filter((event) => event.name === 'tool.wrote')).toHaveLength(2);
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
