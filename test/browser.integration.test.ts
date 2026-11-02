import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { startStatenet } from '@punyts/statenet';
import type { RunningStatenet } from '@punyts/statenet';
import { chromium } from 'playwright';
import type { Browser, Page, WebSocketRoute } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { FORM_DOCUMENT, call, httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData, ToolResult } from './helpers.js';

const installed = await BrowserPreview.isInstalled();

/** Calls a tool until its result passes the check, for state that reaches the server over the page's socket */
async function eventually(harness: HttpHarness, name: string, args: Record<string, unknown>, check: (result: ToolResult) => boolean): Promise<ToolResult> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const result = await call(harness.client, name, args);
        if (check(result) || Date.now() > deadline) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

describe.skipIf(!installed)('headless browser flow (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let appId = '';

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        const created = await call(harness.client, 'ui_app_create', { name: 'form', document: FORM_DOCUMENT });
        appId = created.body['appId'] as string;
    });

    afterAll(async () => {
        await harness.close();
        await data.cleanup();
    });

    it('should open the headless page and render the current revision', async () => {
        // Act
        const preview = await call(harness.client, 'ui_preview', { appId });

        // Assert
        expect(preview.isError).toBe(false);
        expect(preview.body['rendered']).toBe(true);
        expect(preview.body['revision']).toBe(1);
        expect(preview.body['url']).toBe(`${harness.server.origin}/apps/${appId}`);
        expect(preview.body['errors']).toEqual([]);
    });

    it('should return a PNG screenshot of the page and of one node', async () => {
        // Act
        const page = await call(harness.client, 'ui_screenshot', { appId, width: 640, height: 400 });
        const node = await call(harness.client, 'ui_screenshot', { appId, path: '$.app.children.form.children.save' });

        // Assert
        for (const shot of [page, node]) {
            expect(shot.isError).toBe(false);
            expect(shot.images).toHaveLength(1);
            expect(shot.images[0]?.mimeType).toBe('image/png');
            expect(Buffer.from(shot.images[0]?.data ?? '', 'base64').subarray(1, 4).toString()).toBe('PNG');
        }
        expect(page.body['target']).toBe('page');
        expect(node.body['target']).toBe('$.app.children.form.children.save');
    });

    it('should click a button that emits and hand the event to ui_events_read', async () => {
        // Arrange
        const before = await call(harness.client, 'ui_events_read', { appId });

        // Act
        const interacted = await call(harness.client, 'ui_interact', {
            appId,
            actions: [
                { action: 'fill', path: '$.app.children.form.children.email', value: 'a@b.test' },
                { action: 'click', path: '$.app.children.form.children.save' }
            ]
        });
        const after = await call(harness.client, 'ui_events_read', { appId, since: before.body['cursor'] });

        // Assert
        expect(interacted.isError).toBe(false);
        expect((interacted.body['results'] as { ok: boolean }[]).map((step) => step.ok)).toEqual([true, true]);
        expect((interacted.body['emits'] as { name: string }[]).map((event) => event.name)).toEqual(['form.saved']);
        expect((after.body['events'] as { name: string; payload: unknown }[]).map((event) => [event.name, event.payload])).toEqual([['form.saved', 'ok']]);
    });

    it('should have the typed value synced to the server', async () => {
        // Act
        const state = await eventually(harness, 'ui_state_get', { appId }, (result) => JSON.stringify(result.body['state']).includes('a@b.test'));

        // Assert
        expect(JSON.stringify(state.body['state'])).toContain('a@b.test');
        expect((state.body['preview'] as { attached: boolean }).attached).toBe(true);
    });

    it('should report a failed action with the reason and stop there', async () => {
        // Act
        const result = await call(harness.client, 'ui_interact', {
            appId,
            actions: [
                { action: 'click', path: '$.app.children.nothing' },
                { action: 'click', path: '$.app.children.form.children.save' }
            ]
        });

        // Assert
        expect(result.isError).toBe(true);
        const results = result.body['results'] as { ok: boolean; error?: string }[];
        expect(results).toHaveLength(1);
        expect(results[0]?.ok).toBe(false);
        expect(results[0]?.error).toContain('Nothing is rendered');
    });

    it('should follow a document write in the headless page', async () => {
        // Act
        const written = await call(harness.client, 'ui_app_write', {
            appId,
            operations: [{ op: 'set', path: 'app.children.form.children.save._title', value: 'Send now' }],
            expectedRevision: 1
        });
        const preview = await call(harness.client, 'ui_preview', { appId });
        const outline = await call(harness.client, 'ui_outline', { appId });

        // Assert
        expect(written.body['revision']).toBe(2);
        expect(preview.body['rendered']).toBe(true);
        expect(preview.body['revision']).toBe(2);
        expect(String(outline.body['text'])).toContain('Send now');
    });

    it('should add a new key with ui_state_set to the running page and keep it', async () => {
        // Act: a new object under data, then a new record inside it
        await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks', value: { t1: { title: 'first' } } });
        await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks.t2', value: { title: 'second' } });
        const preview = await call(harness.client, 'ui_preview', { appId });
        const state = await call(harness.client, 'ui_state_get', { appId });

        // Assert
        expect(preview.body['rendered']).toBe(true);
        expect((state.body['state'] as { data: unknown }).data).toMatchObject({ tasks: { t1: { title: 'first' }, t2: { title: 'second' } } });
    });

    it('should refuse at once a screenshot of a node that is rendered but not visible', async () => {
        // Arrange: a closed modal keeps its body rendered, but nothing of it is shown
        const created = await call(harness.client, 'ui_app_create', {
            name: 'closed modal',
            document: { app: { component: 'page', children: { dialog: { component: 'modal', _title: 'Hidden', body: { component: 'text', _text: 'inside' } } } } }
        });
        const hiddenAppId = created.body['appId'] as string;
        const started = Date.now();

        // Act
        const shot = await call(harness.client, 'ui_screenshot', { appId: hiddenAppId, path: '$.app.children.dialog.body' });

        // Assert
        expect(shot.isError).toBe(true);
        expect(shot.body['error']).toBe('not-rendered');
        expect(String(shot.body['message'])).toContain('not visible');
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    describe('with an open modal', () => {
        let modalAppId = '';

        beforeAll(async () => {
            const created = await call(harness.client, 'ui_app_create', {
                name: 'open modal',
                document: {
                    app: {
                        component: 'page',
                        children: {
                            behind: { component: 'button', _title: 'Behind' },
                            dialog: { component: 'modal', _title: 'Shown', open: true, body: { component: 'text', _text: 'inside' } }
                        }
                    }
                }
            });
            modalAppId = created.body['appId'] as string;
            await call(harness.client, 'ui_preview', { appId: modalAppId });
        });

        it('should screenshot the dialog of a modal named by its path', async () => {
            // Act: the modal host is display: contents, so the image is of the dialog in its shadow root
            const shot = await call(harness.client, 'ui_screenshot', { appId: modalAppId, path: '$.app.children.dialog', width: 800, height: 600 });

            // Assert
            expect(shot.isError).toBe(false);
            expect(shot.images).toHaveLength(1);
            expect(shot.body['width']).toBeGreaterThan(0);
            expect(shot.body['width']).toBeLessThan(800);
        });

        it('should say that a click is behind the open modal', async () => {
            // Act
            const result = await call(harness.client, 'ui_interact', { appId: modalAppId, actions: [{ action: 'click', path: '$.app.children.behind' }] });

            // Assert
            expect(result.isError).toBe(true);
            expect((result.body['results'] as { error?: string }[])[0]?.error).toContain('behind an open modal dialog');
        });
    });
});

describe.skipIf(!installed)('live sync between pages and the server (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        browser = await chromium.launch();
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    async function createForm(name: string): Promise<string> {
        const created = await call(harness.client, 'ui_app_create', { name, document: FORM_DOCUMENT });
        return created.body['appId'] as string;
    }

    /** A page of the app that has rendered and whose socket is online */
    async function openPage(page: Page, appId: string): Promise<void> {
        await page.goto(`${harness.server.origin}/apps/${appId}`);
        await page.waitForSelector('body[data-status="ready"][data-sync="online"]');
    }

    function email(page: Page) {
        return page.frameLocator('iframe').locator('input').first();
    }

    it('should show a tool write in an open page', async () => {
        // Arrange
        const appId = await createForm('tool write');
        const page = await browser.newPage();
        await openPage(page, appId);

        // Act
        await call(harness.client, 'ui_state_set', { appId, path: '$.app.children.form.children.email.value', value: 'from@tool.test' });

        // Assert
        await expect.poll(() => email(page).inputValue()).toBe('from@tool.test');
        await page.close();
    });

    it('should show the change one page makes in another', async () => {
        // Arrange
        const appId = await createForm('two pages');
        const context = await browser.newContext();
        const first = await context.newPage();
        const second = await context.newPage();
        await openPage(first, appId);
        await openPage(second, appId);

        // Act
        await email(first).fill('shared@pages.test');

        // Assert
        await expect.poll(() => email(second).inputValue()).toBe('shared@pages.test');
        await context.close();
    });

    it('should keep a change made offline across a reload and send it when the socket is back', async () => {
        // Arrange: the page's socket goes through a route that can cut it
        const appId = await createForm('offline');
        const context = await browser.newContext();
        const page = await context.newPage();
        let offline = false;
        const open = new Set<WebSocketRoute>();
        await page.routeWebSocket(/\/sync\?/, (route) => {
            if (offline) {
                route.close();
                return;
            }
            open.add(route);
            route.connectToServer();
        });
        await openPage(page, appId);

        // Act: cut the socket, type, reload while still offline, then let the socket back
        offline = true;
        for (const route of open) await route.close();
        await page.waitForSelector('body[data-sync="offline"]');
        await email(page).fill('typed@offline.test');
        await page.reload();
        await page.waitForSelector('body[data-status="ready"]');
        const shownAfterReload = await email(page).inputValue();
        const serverWhileOffline = await call(harness.client, 'ui_state_get', { appId });
        offline = false;
        const synced = await eventually(harness, 'ui_state_get', { appId }, (result) => JSON.stringify(result.body['state']).includes('typed@offline.test'));

        // Assert
        expect(shownAfterReload).toBe('typed@offline.test');
        expect(JSON.stringify(serverWhileOffline.body['state'])).not.toContain('typed@offline.test');
        expect(JSON.stringify(synced.body['state'])).toContain('typed@offline.test');
        await context.close();
    });

    it('should put back the confirmed value when the server rejects a change', async () => {
        // Arrange: server logic that refuses every change to the form
        const appId = await createForm('rejected');
        const app = await harness.server.services.repository.findById(appId);
        const authority = await harness.server.services.authorities.authority(appId, app?.document ?? {});
        authority.onChange('$.app.children.form', () => ({ result: 'reject', reason: 'read only' }));
        const page = await browser.newPage();
        await openPage(page, appId);

        // Act
        await email(page).fill('refused@server.test');

        // Assert
        await expect.poll(() => email(page).inputValue()).toBe('');
        const state = await call(harness.client, 'ui_state_get', { appId });
        expect(JSON.stringify(state.body['state'])).not.toContain('refused@server.test');
        await page.close();
    });
});

describe.skipIf(!installed)('a Persisted app synced through the statenet alone (Chromium through Playwright)', () => {
    let data: TempData;
    let statenetData: TempData;
    let statenet: RunningStatenet;
    let harness: HttpHarness;
    let browser: Browser;

    beforeAll(async () => {
        data = await tempData();
        statenetData = await tempData();
        // The statenet admits the pages of one origin, so the server's port is chosen first
        const port = await freePort();
        statenet = await startStatenet({ port: 0, dataDir: statenetData.dir, allowedOrigins: [`http://127.0.0.1:${port}`] });
        harness = await httpHarness(data.dir, undefined, { port, runtimePort: 0, statenet: statenet.url });
        browser = await chromium.launch();
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await statenet.close();
        await data.cleanup();
        await statenetData.cleanup();
    });

    it('should show the change one page makes in another, with the state in the statenet', async () => {
        // Arrange
        const created = await call(harness.client, 'ui_app_create', { name: 'persisted pages', document: FORM_DOCUMENT, sync: 'persisted' });
        const appId = created.body['appId'] as string;
        const context = await browser.newContext();
        const first = await context.newPage();
        const second = await context.newPage();
        const sockets: string[] = [];
        first.on('websocket', (socket) => sockets.push(socket.url()));
        for (const page of [first, second]) {
            await page.goto(`${harness.server.origin}/apps/${appId}`);
            await page.waitForSelector('body[data-status="ready"][data-sync="online"]');
        }

        // Act
        await first.frameLocator('iframe').locator('input').first().fill('shared@statenet.test');

        // Assert
        await expect.poll(() => second.frameLocator('iframe').locator('input').first().inputValue()).toBe('shared@statenet.test');
        const stored = await eventually(harness, 'ui_state_get', { appId }, (result) => JSON.stringify(result.body['state']).includes('shared@statenet.test'));
        expect(stored.body['state']).toMatchObject({ app: { children: { form: { children: { email: { value: 'shared@statenet.test' } } } } } });
        expect(await first.evaluate(() => document.body.dataset['statenetUrl'])).toBe(statenet.url);
        // The sync client talks to the statenet; the server's socket carries only the view frames
        expect(sockets).toHaveLength(2);
        expect(sockets).toContain(statenet.url);
        expect(sockets.some((url) => url.startsWith(`${harness.server.origin.replace('http', 'ws')}/apps/${appId}/sync?`))).toBe(true);
        await context.close();
    });
});

/** A port nothing listens on right now */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            server.close(() => resolve(port));
        });
    });
}
