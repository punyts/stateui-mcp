import { chromium } from 'playwright';
import type { Browser, Page, WebSocketRoute } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { call, createApp, httpHarness, shellOf, tempData } from './helpers.js';
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

/** Calls a tool that must succeed */
async function step(harness: HttpHarness, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await call(harness.client, name, args);
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.body)}`);
    return result;
}

/** A dataset of items, each with a title, for the apps that bind data */
async function seedItems(harness: HttpHarness, records: Record<string, string>): Promise<void> {
    await step(harness, 'ui_model_write', { model: 'item', operations: [{ op: 'set', field: 'title', type: 'string', required: true }] });
    await step(harness, 'ui_data_write', {
        dataset: 'items',
        model: 'item',
        operations: Object.entries(records).map(([key, title]) => ({ op: 'set', path: key, value: { title } }))
    });
}

/** Writes nodes of the shell, at the revision the app has now */
async function writeShell(harness: HttpHarness, app: string, expectedRevision: number, operations: readonly object[]): Promise<ToolResult> {
    return call(harness.client, 'ui_nodes_write', { app, screen: 'shell', expectedRevision, operations });
}

/** The revision the runtime page last rendered, from the preview block of ui_state_get */
function renderedRevision(result: ToolResult): number | undefined {
    return (result.body['preview'] as { revision?: number }).revision;
}

describe.skipIf(!installed)('headless browser flow (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let appId = '';

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        appId = (await createApp(harness.client, 'form')).id;
    });

    afterAll(async () => {
        await harness.close();
        await data.cleanup();
    });

    it('should open the headless page and render the current revision', async () => {
        // Act
        const preview = await call(harness.client, 'ui_preview', { app: 'form' });

        // Assert
        expect(preview.isError).toBe(false);
        expect(preview.body['rendered']).toBe(true);
        expect(preview.body['revision']).toBe(1);
        expect(preview.body['url']).toBe(`${harness.server.origin}/apps/${appId}`);
        expect(preview.body['errors']).toEqual([]);
    });

    it('should return a PNG screenshot of the page and of one node', async () => {
        // Act
        const page = await call(harness.client, 'ui_screenshot', { app: 'form', width: 640, height: 400 });
        const node = await call(harness.client, 'ui_screenshot', { app: 'form', path: '$.app.children.form.children.save' });

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
        const before = await call(harness.client, 'ui_events_read', { app: 'form' });

        // Act
        const interacted = await call(harness.client, 'ui_interact', {
            app: 'form',
            actions: [
                { action: 'fill', path: '$.app.children.form.children.email', value: 'a@b.test' },
                { action: 'click', path: '$.app.children.form.children.save' }
            ]
        });
        const after = await call(harness.client, 'ui_events_read', { app: 'form', since: before.body['cursor'] });

        // Assert
        expect(interacted.isError).toBe(false);
        expect((interacted.body['results'] as { ok: boolean }[]).map((result) => result.ok)).toEqual([true, true]);
        expect((interacted.body['emits'] as { name: string }[]).map((event) => event.name)).toEqual(['form.saved']);
        expect((after.body['events'] as { name: string; payload: unknown }[]).map((event) => [event.name, event.payload])).toEqual([['form.saved', 'ok']]);
    });

    it('should have the typed value synced to the server', async () => {
        // Act
        const state = await eventually(harness, 'ui_state_get', { app: 'form' }, (result) => JSON.stringify(result.body['state']).includes('a@b.test'));

        // Assert
        expect(JSON.stringify(state.body['state'])).toContain('a@b.test');
        expect((state.body['preview'] as { attached: boolean }).attached).toBe(true);
    });

    it('should report a failed action with the reason and stop there', async () => {
        // Act
        const result = await call(harness.client, 'ui_interact', {
            app: 'form',
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

    it('should follow a node write in the headless page', async () => {
        // Act
        const written = await writeShell(harness, 'form', 1, [{ op: 'set', path: 'root.children.form.children.save._title', value: 'Send now' }]);
        const preview = await call(harness.client, 'ui_preview', { app: 'form' });
        const tree = await call(harness.client, 'ui_tree', { app: 'form', content: true });

        // Assert
        expect(written.body['revision']).toBe(2);
        expect(preview.body['rendered']).toBe(true);
        expect(preview.body['revision']).toBe(2);
        expect(String(tree.body['text'])).toContain('Send now');
    });

    it('should swap a node for another component in the open page without a runtime error', async () => {
        // Arrange
        await createApp(harness.client, 'swap', shellOf({ k: { component: 'stat', _label: 'Cash', value: 3 } }));
        await call(harness.client, 'ui_preview', { app: 'swap' });

        // Act
        await writeShell(harness, 'swap', 1, [
            { op: 'set', path: 'root.children.k', value: { component: 'panel', bordered: true, children: { v: { component: 'stat', _label: 'Boxed', value: 3 } } } }
        ]);
        await eventually(harness, 'ui_state_get', { app: 'swap' }, (result) => renderedRevision(result) === 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const state = await call(harness.client, 'ui_state_get', { app: 'swap' });
        const tree = await call(harness.client, 'ui_tree', { app: 'swap', content: true });

        // Assert
        expect(JSON.stringify((state.body['preview'] as { errors: unknown[] }).errors)).toBe('[]');
        expect(String(tree.body['text'])).toContain('Boxed');
    });

    it('should follow a move that only reorders the children of a container in the open page', async () => {
        // Arrange
        const children = { a: { component: 'text', _text: 'alpha' }, b: { component: 'text', _text: 'beta' }, c: { component: 'text', _text: 'gamma' } };
        await createApp(harness.client, 'reorder', shellOf({ list: { component: 'panel', children } }));
        const preview = await call(harness.client, 'ui_preview', { app: 'reorder' });
        const browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto(String(preview.body['url']));
        const frame = page.frameLocator('iframe');
        await frame.getByText('gamma').waitFor();
        // The text of each child in rendered order (a text node renders its text in its shadow root)
        const order = async (): Promise<string[]> => frame.locator('ui-panel ui-text').evaluateAll((items) => items.map((item) => (item.shadowRoot ?? item).textContent?.trim() ?? ''));
        const before = await order();

        // Act
        const moved = await writeShell(harness, 'reorder', 1, [{ op: 'move', path: 'root.children.list.children.c', before: 'a' }]);
        await eventually(harness, 'ui_state_get', { app: 'reorder' }, (result) => renderedRevision(result) === 2);
        const deadline = Date.now() + 5000;
        let after = await order();
        while (after[0] !== 'gamma' && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            after = await order();
        }
        const state = await call(harness.client, 'ui_state_get', { app: 'reorder' });
        await browser.close();

        // Assert
        expect(moved.isError).toBe(false);
        expect(JSON.stringify((state.body['preview'] as { errors: unknown[] }).errors)).toBe('[]');
        expect(before).toEqual(['alpha', 'beta', 'gamma']);
        expect(after).toEqual(['gamma', 'alpha', 'beta']);
    });

    it('should re-point a changed link in the open page', async () => {
        // Arrange
        await seedItems(harness, { i1: 'first-value', i2: 'second-value' });
        await createApp(harness.client, 'relink', shellOf({ k: { component: 'text', '<-_text': '$.data.items.i1.title' } }), { data: { items: { dataset: 'items' } } });
        const preview = await call(harness.client, 'ui_preview', { app: 'relink' });
        const browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto(String(preview.body['url']));
        const shown = page.frameLocator('iframe').getByText('first-value');
        await shown.waitFor();

        // Act
        await writeShell(harness, 'relink', 1, [{ op: 'set', path: 'root.children.k.<-_text', value: '$.data.items.i2.title' }]);
        await eventually(harness, 'ui_state_get', { app: 'relink' }, (result) => renderedRevision(result) === 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const state = await call(harness.client, 'ui_state_get', { app: 'relink' });
        const relinked = page.frameLocator('iframe').getByText('second-value');
        await relinked.waitFor({ timeout: 5000 });
        const newCount = await relinked.count();
        const oldCount = await page.frameLocator('iframe').getByText('first-value').count();
        await browser.close();

        // Assert
        expect(JSON.stringify((state.body['preview'] as { errors: unknown[] }).errors)).toBe('[]');
        expect(newCount).toBe(1);
        expect(oldCount).toBe(0);
    });

    it('should add a new key with ui_state_set to the running page and keep it', async () => {
        // Arrange
        await step(harness, 'ui_model_write', { model: 'task', operations: [{ op: 'set', field: 'title', type: 'string', required: true }] });
        await createApp(harness.client, 'tasks', shellOf({}), { data: { tasks: { model: 'task', scope: 'persona' } } });

        // Act: a new object under the binding, then a new record inside it
        await call(harness.client, 'ui_state_set', { app: 'tasks', path: '$.data.tasks', value: { t1: { title: 'first' } } });
        await call(harness.client, 'ui_state_set', { app: 'tasks', path: '$.data.tasks.t2', value: { title: 'second' } });
        const preview = await call(harness.client, 'ui_preview', { app: 'tasks' });
        const state = await call(harness.client, 'ui_state_get', { app: 'tasks' });

        // Assert
        expect(preview.body['rendered']).toBe(true);
        expect((state.body['state'] as { data: unknown }).data).toMatchObject({ tasks: { t1: { title: 'first' }, t2: { title: 'second' } } });
    });

    it('should refuse at once a screenshot of a node that is rendered but not visible', async () => {
        // Arrange: a closed modal keeps its body rendered, but nothing of it is shown
        await createApp(harness.client, 'closed-modal', shellOf({ dialog: { component: 'modal', _title: 'Hidden', body: { component: 'text', _text: 'inside' } } }));
        const started = Date.now();

        // Act
        const shot = await call(harness.client, 'ui_screenshot', { app: 'closed-modal', path: '$.app.children.dialog.body' });

        // Assert
        expect(shot.isError).toBe(true);
        expect(shot.body['error']).toBe('not-rendered');
        expect(String(shot.body['message'])).toContain('not visible');
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    describe('with an open modal', () => {
        beforeAll(async () => {
            await createApp(
                harness.client,
                'open-modal',
                shellOf({
                    behind: { component: 'button', _title: 'Behind' },
                    dialog: { component: 'modal', _title: 'Shown', open: true, body: { component: 'text', _text: 'inside' } }
                })
            );
            await call(harness.client, 'ui_preview', { app: 'open-modal' });
        });

        it('should screenshot the dialog of a modal named by its path', async () => {
            // Act: the modal host is display: contents, so the image is of the dialog in its shadow root
            const shot = await call(harness.client, 'ui_screenshot', { app: 'open-modal', path: '$.app.children.dialog', width: 800, height: 600 });

            // Assert
            expect(shot.isError).toBe(false);
            expect(shot.images).toHaveLength(1);
            expect(shot.body['width']).toBeGreaterThan(0);
            expect(shot.body['width']).toBeLessThan(800);
        });

        it('should say that a click is behind the open modal', async () => {
            // Act
            const result = await call(harness.client, 'ui_interact', { app: 'open-modal', actions: [{ action: 'click', path: '$.app.children.behind' }] });

            // Assert
            expect(result.isError).toBe(true);
            expect((result.body['results'] as { error?: string }[])[0]?.error).toContain('behind an open modal dialog');
        });

        it('should refuse fill, choose, press and focus on a node behind the open modal, not report ok', async () => {
            // Arrange
            await createApp(
                harness.client,
                'open-modal-with-fields',
                shellOf({
                    name: { component: 'textField', _label: 'Name' },
                    view: { component: 'segmented', value: 'open', options: { open: { _label: 'Open' }, overdue: { _label: 'Overdue' } } },
                    dialog: { component: 'modal', _title: 'Shown', open: true, body: { component: 'text', _text: 'inside' } }
                })
            );
            await call(harness.client, 'ui_preview', { app: 'open-modal-with-fields' });

            // Act
            const results: { ok: boolean; error?: string }[] = [];
            for (const action of [
                { action: 'fill', path: '$.app.children.name', value: 'x' },
                { action: 'choose', path: '$.app.children.view', value: 'overdue' },
                { action: 'press', path: '$.app.children.name', value: 'Enter' },
                { action: 'focus', path: '$.app.children.name' }
            ]) {
                const result = await call(harness.client, 'ui_interact', { app: 'open-modal-with-fields', actions: [action] });
                results.push(...(result.body['results'] as { ok: boolean; error?: string }[]));
            }

            // Assert
            expect(results.map((result) => result.ok)).toEqual([false, false, false, false]);
            for (const result of results) expect(result.error).toContain('behind an open modal dialog');
        });
    });
});

describe.skipIf(!installed)('ui_interact choose and ui_preview reload (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let appId = '';

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        appId = (
            await createApp(
                harness.client,
                'choices',
                shellOf({
                    view: { component: 'segmented', value: 'open', options: { open: { _label: 'Open' }, overdue: { _label: 'Overdue' } } },
                    size: { component: 'radioField', _label: 'Size', value: 'm', options: { s: { _label: 'Small' }, m: { _label: 'Medium' } } },
                    pick: { component: 'selectField', _label: 'Pick', value: 'a', options: { a: { _label: 'Alpha one' }, b: { _label: 'Beta two' } } }
                })
            )
        ).id;
        await call(harness.client, 'ui_preview', { app: 'choices' });
    });

    afterAll(async () => {
        await harness.close();
        await data.cleanup();
    });

    async function choose(path: string, value: string): Promise<ToolResult> {
        return call(harness.client, 'ui_interact', { app: 'choices', actions: [{ action: 'choose', path: '$.app.children.' + path, value }] });
    }

    /** The values the three controls hold in the instance */
    async function valuesNow(): Promise<Record<string, unknown>> {
        const state = await eventually(harness, 'ui_state_get', { app: 'choices' }, () => true);
        const children = (state.body['state'] as { app: { children: Record<string, { value?: unknown }> } }).app.children;
        return Object.fromEntries(Object.entries(children).map(([name, node]) => [name, node.value]));
    }

    it('should choose a segment by its option value', async () => {
        // Act
        const result = await choose('view', 'overdue');

        // Assert
        expect(result.isError).toBe(false);
        expect(await valuesNow()).toMatchObject({ view: 'overdue' });
    });

    it('should choose a segment by its label', async () => {
        // Arrange
        await choose('view', 'open');

        // Act
        const result = await choose('view', 'Overdue');

        // Assert
        expect(result.isError).toBe(false);
        expect(await valuesNow()).toMatchObject({ view: 'overdue' });
    });

    it('should choose a radio by value and by label, and a select option by value and by label', async () => {
        // Act
        const radioByValue = await choose('size', 's');
        const radioByLabel = await choose('size', 'Medium');
        const selectByValue = await choose('pick', 'b');
        const selectByLabel = await choose('pick', 'Alpha one');

        // Assert
        expect([radioByValue, radioByLabel, selectByValue, selectByLabel].map((result) => result.isError)).toEqual([false, false, false, false]);
        expect(await valuesNow()).toMatchObject({ size: 'm', pick: 'a' });
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
        const first = await call(harness.client, 'ui_preview', { app: 'choices' });
        const attach = vi.spyOn(harness.server.services.hub, 'attach');

        // Act
        const second = await call(harness.client, 'ui_preview', { app: 'choices' });

        // Assert
        expect(attach).toHaveBeenCalledTimes(1);
        expect(second.body['rendered']).toBe(true);
        expect(second.body['url']).toBe(first.body['url']);
        attach.mockRestore();
    });

    it('should read the state of the instance with a view open, and again with the page closed', async () => {
        // Arrange
        const open = await call(harness.client, 'ui_state_get', { app: 'choices' });
        await harness.server.services.browser.closePage(appId);
        await eventually(harness, 'ui_state_get', { app: 'choices' }, (state) => (state.body['preview'] as { attached: boolean }).attached === false);

        // Act
        const closed = await call(harness.client, 'ui_state_get', { app: 'choices' });

        // Assert
        expect(open.body).toMatchObject({ source: 'instance', preview: { attached: true } });
        expect(closed.body).toMatchObject({ source: 'instance', preview: { attached: false } });
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
        const app = await createApp(harness.client, 'tool-write');
        const page = await browser.newPage();
        await openPage(page, app.id);

        // Act
        await call(harness.client, 'ui_state_set', { app: app.name, path: '$.app.children.form.children.email.value', value: 'from@tool.test' });

        // Assert
        await expect.poll(() => email(page).inputValue()).toBe('from@tool.test');
        await page.close();
    });

    it('should show the change one page makes in another', async () => {
        // Arrange
        const app = await createApp(harness.client, 'two-pages');
        const context = await browser.newContext();
        const first = await context.newPage();
        const second = await context.newPage();
        await openPage(first, app.id);
        await openPage(second, app.id);

        // Act
        await email(first).fill('shared@pages.test');

        // Assert
        await expect.poll(() => email(second).inputValue()).toBe('shared@pages.test');
        await context.close();
    });

    it('should keep a change made offline across a reload and send it when the socket is back', async () => {
        // Arrange: the page's socket goes through a route that can cut it
        const app = await createApp(harness.client, 'offline');
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
        await openPage(page, app.id);

        // Act: cut the socket, type, reload while still offline, then let the socket back
        offline = true;
        for (const route of open) await route.close();
        await page.waitForSelector('body[data-sync="offline"]');
        await email(page).fill('typed@offline.test');
        await page.reload();
        await page.waitForSelector('body[data-status="ready"]');
        const shownAfterReload = await email(page).inputValue();
        const serverWhileOffline = await call(harness.client, 'ui_state_get', { app: app.name });
        offline = false;
        const synced = await eventually(harness, 'ui_state_get', { app: app.name }, (result) => JSON.stringify(result.body['state']).includes('typed@offline.test'));

        // Assert
        expect(shownAfterReload).toBe('typed@offline.test');
        expect(JSON.stringify(serverWhileOffline.body['state'])).not.toContain('typed@offline.test');
        expect(JSON.stringify(synced.body['state'])).toContain('typed@offline.test');
        await context.close();
    });

    it('should put back the confirmed value when the server rejects a change', async () => {
        // Arrange: server logic that refuses every change to the form
        const app = await createApp(harness.client, 'rejected');
        const found = await harness.server.services.useCases.findPartApp.execute(app.name);
        if (found.kind !== 'found') throw new Error('the app is stored');
        const authority = await harness.server.services.instanceViews.authority(found.part);
        authority.onChange('$.app.children.form', () => ({ result: 'reject', reason: 'read only' }));
        const page = await browser.newPage();
        await openPage(page, app.id);

        // Act
        await email(page).fill('refused@server.test');

        // Assert
        await expect.poll(() => email(page).inputValue()).toBe('');
        const state = await call(harness.client, 'ui_state_get', { app: app.name });
        expect(JSON.stringify(state.body['state'])).not.toContain('refused@server.test');
        await page.close();
    });
});
