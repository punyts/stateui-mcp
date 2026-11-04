import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { startStatenet } from '@punyts/statenet';
import type { RunningStatenet } from '@punyts/statenet';
import { chromium } from 'playwright';
import type { Browser, Page, WebSocketRoute } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

    it('should swap a node for another component in the open page without a runtime error', async () => {
        // Arrange
        const document = Object.freeze({
            data: Object.freeze({ n: 3 }),
            app: Object.freeze({ component: 'page', children: Object.freeze({ k: Object.freeze({ component: 'stat', _label: 'Cash', '<-value': '$.data.n' }) }) })
        });
        const created = await call(harness.client, 'ui_app_create', { name: 'swap', document });
        const swapId = created.body['appId'] as string;
        await call(harness.client, 'ui_preview', { appId: swapId });

        // Act
        await call(harness.client, 'ui_app_write', {
            appId: swapId,
            operations: [{ op: 'set', path: 'app.children.k', value: { component: 'panel', bordered: true, children: { v: { component: 'stat', _label: 'Boxed', '<-value': '$.data.n' } } } }],
            expectedRevision: 1
        });
        await eventually(harness, 'ui_validate', { appId: swapId }, (result) => (result.body['preview'] as { revision?: number }).revision === 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const validated = await call(harness.client, 'ui_validate', { appId: swapId });
        const outline = await call(harness.client, 'ui_outline', { appId: swapId });

        // Assert
        expect(JSON.stringify((validated.body["preview"] as { errors: unknown[] }).errors)).toBe("[]");
        expect(String(outline.body['text'])).toContain('Boxed');
    });

    it('should re-point a changed link in the open page', async () => {
        // Arrange
        const document = Object.freeze({
            data: Object.freeze({ n: 'first-value', m: 'second-value' }),
            app: Object.freeze({ component: 'page', children: Object.freeze({ k: Object.freeze({ component: 'text', '<-_text': '$.data.n' }) }) })
        });
        const created = await call(harness.client, 'ui_app_create', { name: 'relink', document });
        const relinkId = created.body['appId'] as string;
        const preview = await call(harness.client, 'ui_preview', { appId: relinkId });
        const browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto(String(preview.body['url']));
        const shown = page.frameLocator('iframe').getByText('first-value');
        await shown.waitFor();

        // Act
        await call(harness.client, 'ui_app_write', {
            appId: relinkId,
            operations: [{ op: 'set', path: 'app.children.k.<-_text', value: '$.data.m' }],
            expectedRevision: 1
        });
        await eventually(harness, 'ui_validate', { appId: relinkId }, (result) => (result.body['preview'] as { revision?: number }).revision === 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const validated = await call(harness.client, 'ui_validate', { appId: relinkId });
        const relinked = page.frameLocator('iframe').getByText('second-value');
        await relinked.waitFor({ timeout: 5000 });
        const newCount = await relinked.count();
        const oldCount = await page.frameLocator('iframe').getByText('first-value').count();
        await browser.close();

        // Assert
        expect(JSON.stringify((validated.body['preview'] as { errors: unknown[] }).errors)).toBe('[]');
        expect(newCount).toBe(1);
        expect(oldCount).toBe(0);
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

        it('should refuse fill, choose, press and focus on a node behind the open modal, not report ok', async () => {
            // Arrange
            const created = await call(harness.client, 'ui_app_create', {
                name: 'open modal with fields',
                document: {
                    data: { view: 'open' },
                    app: {
                        component: 'page',
                        children: {
                            name: { component: 'textField', _label: 'Name' },
                            view: { component: 'segmented', options: { open: { _label: 'Open' }, overdue: { _label: 'Overdue' } }, '<-value': '$.data.view' },
                            dialog: { component: 'modal', _title: 'Shown', open: true, body: { component: 'text', _text: 'inside' } }
                        }
                    }
                }
            });
            const appId = created.body['appId'] as string;
            await call(harness.client, 'ui_preview', { appId });

            // Act
            const results: { ok: boolean; error?: string }[] = [];
            for (const action of [
                { action: 'fill', path: '$.app.children.name', value: 'x' },
                { action: 'choose', path: '$.app.children.view', value: 'overdue' },
                { action: 'press', path: '$.app.children.name', value: 'Enter' },
                { action: 'focus', path: '$.app.children.name' }
            ]) {
                const result = await call(harness.client, 'ui_interact', { appId, actions: [action] });
                results.push(...(result.body['results'] as { ok: boolean; error?: string }[]));
            }

            // Assert
            expect(results.map((result) => result.ok)).toEqual([false, false, false, false]);
            for (const result of results) expect(result.error).toContain('behind an open modal dialog');
        });
    });
});

describe.skipIf(!installed)('ui_interact choose, ui_preview reload and the live ui_state_get (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let appId = '';

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        const created = await call(harness.client, 'ui_app_create', {
            name: 'choices',
            document: {
                data: { view: 'open', pick: 'a', size: 'm' },
                app: {
                    component: 'page',
                    children: {
                        view: { component: 'segmented', options: { open: { _label: 'Open' }, overdue: { _label: 'Overdue' } }, '<-value': '$.data.view' },
                        size: { component: 'radioField', _label: 'Size', options: { s: { _label: 'Small' }, m: { _label: 'Medium' } }, '<-value': '$.data.size' },
                        pick: { component: 'selectField', _label: 'Pick', options: { a: { _label: 'Alpha one' }, b: { _label: 'Beta two' } }, '<-value': '$.data.pick' }
                    }
                }
            }
        });
        appId = created.body['appId'] as string;
        await call(harness.client, 'ui_preview', { appId });
    });

    afterAll(async () => {
        await harness.close();
        await data.cleanup();
    });

    async function choose(path: string, value: string): Promise<ToolResult> {
        return call(harness.client, 'ui_interact', { appId, actions: [{ action: 'choose', path: '$.app.children.' + path, value }] });
    }

    async function dataNow(): Promise<Record<string, unknown>> {
        const state = await eventually(harness, 'ui_state_get', { appId }, () => true);
        return (state.body['state'] as { data: Record<string, unknown> }).data;
    }

    it('should choose a segment by its option value', async () => {
        // Act
        const result = await choose('view', 'overdue');

        // Assert
        expect(result.isError).toBe(false);
        expect(await dataNow()).toMatchObject({ view: 'overdue' });
    });

    it('should choose a segment by its label', async () => {
        // Arrange
        await choose('view', 'open');

        // Act
        const result = await choose('view', 'Overdue');

        // Assert
        expect(result.isError).toBe(false);
        expect(await dataNow()).toMatchObject({ view: 'overdue' });
    });

    it('should choose a radio by value and by label, and a select option by value and by label', async () => {
        // Act
        const radioByValue = await choose('size', 's');
        const radioByLabel = await choose('size', 'Medium');
        const selectByValue = await choose('pick', 'b');
        const selectByLabel = await choose('pick', 'Alpha one');

        // Assert
        expect([radioByValue, radioByLabel, selectByValue, selectByLabel].map((result) => result.isError)).toEqual([false, false, false, false]);
        expect(await dataNow()).toMatchObject({ size: 'm', pick: 'a' });
    });

    it('should list the values and the labels when no option matches', async () => {
        // Act
        const result = await choose('view', 'nothing');

        // Assert
        expect(result.isError).toBe(true);
        const message = String((result.body['results'] as { error?: string }[])[0]?.error);
        expect(message).toContain('Values: "open", "overdue"');
        expect(message).toContain('Labels: "Open", "Overdue"');
    });

    it('should load the headless page again on a repeat ui_preview and return the same url', async () => {
        // Arrange
        const first = await call(harness.client, 'ui_preview', { appId });
        const attach = vi.spyOn(harness.server.services.hub, 'attach');

        // Act
        const second = await call(harness.client, 'ui_preview', { appId });

        // Assert
        expect(attach).toHaveBeenCalledTimes(1);
        expect(second.body['rendered']).toBe(true);
        expect(second.body['url']).toBe(first.body['url']);
        attach.mockRestore();
    });

    it('should read the state live from the headless page, and the stored copy once it is closed', async () => {
        // Arrange
        const live = await call(harness.client, 'ui_state_get', { appId });
        await harness.server.services.browser.closePage(appId);
        await eventually(harness, 'ui_state_get', { appId }, (state) => state.body['source'] === 'stored');

        // Act
        const stored = await call(harness.client, 'ui_state_get', { appId });

        // Assert
        expect(live.body['source']).toBe('live');
        expect(stored.body).toMatchObject({ source: 'stored', preview: { attached: false } });
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
