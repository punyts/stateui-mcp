import { chromium } from 'playwright';
import type { Browser, Page, WebSocketRoute } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { call, createApp, httpHarness, shellOf, tempData } from './helpers.js';
import type { HttpHarness, TempData, ToolResult } from './helpers.js';
import { readFile, writeFile } from 'node:fs/promises';
import { UNREFERENCED_FILE_GRACE_MS } from '../src/domain/UiFile.js';
import { FileUiFileRepository } from '../src/infrastructure/storage/FileUiFileRepository.js';
import { KeyedLock } from '../src/infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../src/infrastructure/storage/PartFolders.js';

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

/** What a PNG shows, read in a blank Chromium page: its size, the colour at its centre, and where the red dot is */
interface ShotPixels {
    readonly width: number;
    readonly height: number;
    readonly center: readonly [number, number, number];
    /** The mean x of the pure red pixels (the dot), or -1 when there are none */
    readonly redX: number;
    /** The number of different colours: 1 for a blank image */
    readonly colours: number;
}

async function readPixels(page: Page, result: ToolResult): Promise<ShotPixels> {
    const data = result.images[0]?.data ?? '';
    return page.evaluate(async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        context.drawImage(image, 0, 0);
        const { data: pixels } = context.getImageData(0, 0, image.width, image.height);
        const colours = new Set<number>();
        let redSum = 0;
        let redCount = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            const [r, g, b] = [pixels[index] as number, pixels[index + 1] as number, pixels[index + 2] as number];
            colours.add((r << 16) | (g << 8) | b);
            if (r > 200 && g < 40 && b < 40) {
                redSum += (index / 4) % image.width;
                redCount += 1;
            }
        }
        const at = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
        const center: [number, number, number] = [pixels[at] as number, pixels[at + 1] as number, pixels[at + 2] as number];
        return { width: image.width, height: image.height, center, redX: redCount === 0 ? -1 : redSum / redCount, colours: colours.size };
    }, data);
}

/** `rgb(r, g, b)` as numbers */
function rgbOf(css: string): [number, number, number] {
    const [r = -1, g = -1, b = -1] = (css.match(/\d+/g) ?? []).map(Number);
    return [r, g, b];
}

describe.skipIf(!installed)('drawings through the agent tools: release 1A of the graphics epic 1 (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    let blank: Page;
    const DRAWING = '$.app.children.map';
    const DOT = `${DRAWING}.children.dot`;

    /**
     * The drawing an agent writes from the kit instructions and ui_component_get: a backdrop rect filled with a theme
     * token over the whole viewBox, a red circle whose cx is linked to $.data and whose press sets a state value, and a
     * label. The circle sits left of the centre, so the centre pixel of a capture is the token colour
     */
    const drawing = {
        component: 'drawing',
        _title: 'Seat map',
        viewBox: { x: 0, y: 0, width: 200, height: 100 },
        children: {
            backdrop: { component: 'rect', x: 0, y: 0, width: 200, height: 100, fill: '{color.accent.base}' },
            dot: {
                component: 'circle',
                '<-cx': '$.data.pos.p1.x',
                cy: 50,
                r: 12,
                fill: '#ff0000',
                interactive: true,
                _label: 'Seat dot',
                on: { press: [{ command: 'set', target: '$.data.pos.p1.chosen', value: 'yes' }] }
            },
            label: { component: 'drawText', x: 150, y: 20, _text: 'Seats', fill: '#000000' }
        }
    };

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        browser = await chromium.launch();
        blank = await browser.newPage();
        await step(harness, 'ui_model_write', {
            model: 'point',
            operations: [
                { op: 'set', field: 'x', type: 'number' },
                { op: 'set', field: 'chosen', type: 'string' }
            ]
        });
        await step(harness, 'ui_data_write', { dataset: 'points', model: 'point', operations: [{ op: 'set', path: 'p1', value: { x: 40, chosen: 'no' } }] });
        await createApp(harness.client, 'seats', shellOf({}), { data: { pos: { dataset: 'points' } } });
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    it('should accept the drawing from the kit vocabulary and validate it', async () => {
        // Arrange: what the agent reads before it writes
        const instructions = harness.client.getInstructions() ?? '';
        const components = await Promise.all(['drawing', 'rect', 'circle', 'drawText'].map((component) => call(harness.client, 'ui_component_get', { name: component })));

        // Act
        const written = await writeShell(harness, 'seats', 1, [{ op: 'set', path: 'root.children.map', value: drawing }]);
        const validated = await call(harness.client, 'ui_validate', { app: 'seats' });

        // Assert
        expect(instructions).toContain('ui_tree with rendered: true lists its interactive shapes');
        expect(components.map((component) => component.isError)).toEqual([false, false, false, false]);
        expect(written.isError).toBe(false);
        expect(validated.body['valid']).toBe(true);
        expect(validated.body['errors']).toEqual([]);
    });

    it('should screenshot the drawing with the token colour at its centre and the dot drawn', async () => {
        // Arrange: the colour the token resolves to, read from a page of the same app
        const preview = await call(harness.client, 'ui_preview', { app: 'seats' });
        const own = await browser.newPage();
        await own.goto(String(preview.body['url']));
        const fill = await own
            .frameLocator('iframe')
            .locator('ui-drawing[data-render="ready"]')
            .evaluate((host) => {
                const backdrop = host.shadowRoot?.querySelector('[data-shape-path$=".backdrop"]');
                return backdrop === null || backdrop === undefined ? '' : getComputedStyle(backdrop).fill;
            });
        await own.close();

        // Act
        const shot = await call(harness.client, 'ui_screenshot', { app: 'seats', path: DRAWING });
        const pixels = await readPixels(blank, shot);

        // Assert
        expect(shot.isError).toBe(false);
        expect(shot.body['target']).toBe(DRAWING);
        expect(shot.body['scenes']).toBeUndefined();
        expect(pixels.colours).toBeGreaterThan(2);
        const token = rgbOf(fill);
        pixels.center.forEach((channel, index) => expect(Math.abs(channel - (token[index] as number))).toBeLessThanOrEqual(2));
        expect(pixels.redX).toBeGreaterThan(0);
        expect(pixels.redX).toBeLessThan(pixels.width / 2);
    });

    it('should list the interactive shape in ui_tree rendered, and not the others', async () => {
        // Act
        const tree = await call(harness.client, 'ui_tree', { app: 'seats', rendered: true, path: DRAWING });

        // Assert
        expect(tree.isError).toBe(false);
        const text = String(tree.body['text']);
        expect(text).toContain(`dot (circle) ${DOT}`);
        expect(text).not.toContain('backdrop');
        expect(text).not.toContain('drawText');
    });

    it('should press the circle with ui_interact click and change the state value once', async () => {
        // Act
        const clicked = await call(harness.client, 'ui_interact', { app: 'seats', actions: [{ action: 'click', path: DOT }] });
        const state = await eventually(harness, 'ui_state_get', { app: 'seats', path: '$.data.pos.p1' }, (result) => JSON.stringify(result.body).includes('"yes"'));

        // Assert
        expect(clicked.isError).toBe(false);
        expect(clicked.body['errors']).toEqual([]);
        expect(JSON.stringify(state.body)).toContain('"chosen":"yes"');
    });

    it('should hover, focus and press a key on the circle, and refuse fill on it naming what a shape takes', async () => {
        // Arrange
        await step(harness, 'ui_data_write', { dataset: 'points', operations: [{ op: 'set', path: 'p1.chosen', value: 'no' }] });
        await eventually(harness, 'ui_state_get', { app: 'seats', path: '$.data.pos.p1' }, (result) => JSON.stringify(result.body).includes('"chosen":"no"'));

        // Act
        const acted = await call(harness.client, 'ui_interact', {
            app: 'seats',
            actions: [
                { action: 'hover', path: DOT },
                { action: 'focus', path: DOT },
                { action: 'press', path: DOT, value: 'Enter' }
            ]
        });
        const pressed = await eventually(harness, 'ui_state_get', { app: 'seats', path: '$.data.pos.p1' }, (result) => JSON.stringify(result.body).includes('"yes"'));
        const filled = await call(harness.client, 'ui_interact', { app: 'seats', actions: [{ action: 'fill', path: DOT, value: 'x' }] });

        // Assert
        expect((acted.body['results'] as { ok: boolean }[]).map((result) => result.ok)).toEqual([true, true, true]);
        expect(JSON.stringify(pressed.body)).toContain('"chosen":"yes"');
        expect(filled.isError).toBe(true);
        expect((filled.body['results'] as { error?: string }[])[0]?.error).toBe(`${DOT} is a shape (circle), which takes click, press, hover, focus, key, drag, not fill`);
    });

    it('should name the path when no shape is drawn there', async () => {
        // Act
        const result = await call(harness.client, 'ui_interact', { app: 'seats', actions: [{ action: 'click', path: `${DRAWING}.children.nothing` }] });

        // Assert
        expect(result.isError).toBe(true);
        expect((result.body['results'] as { error?: string }[])[0]?.error).toContain(`Nothing is rendered at ${DRAWING}.children.nothing`);
    });

    it('should move the circle in the next screenshot when the linked $.data value changes (a dataset write)', async () => {
        // Arrange
        const before = await readPixels(blank, await call(harness.client, 'ui_screenshot', { app: 'seats', path: DRAWING }));

        // Act
        await step(harness, 'ui_data_write', { dataset: 'points', operations: [{ op: 'set', path: 'p1.x', value: 160 }] });
        const after = await readPixels(blank, await call(harness.client, 'ui_screenshot', { app: 'seats', path: DRAWING }));

        // Assert
        expect(before.redX).toBeLessThan(before.width / 2);
        expect(after.redX).toBeGreaterThan(after.width / 2);
    });

    it('should draw the token colour of the dark mode in a mode: "dark" screenshot', async () => {
        // Arrange
        const light = await readPixels(blank, await call(harness.client, 'ui_screenshot', { app: 'seats', path: DRAWING }));

        // Act
        const shot = await call(harness.client, 'ui_screenshot', { app: 'seats', path: DRAWING, mode: 'dark' });
        const dark = await readPixels(blank, shot);

        // Assert
        expect(shot.isError).toBe(false);
        expect(shot.body['mode']).toBe('dark');
        expect(dark.center).not.toEqual(light.center);
    });
});

describe.skipIf(!installed)('dragging shapes with ui_interact: G1.10b of the graphics epic 1 (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    const MAP = '$.app.children.map';
    const PLAN = '$.app.children.plan';

    /**
     * A drawing on a renderer: a draggable blue block whose x and y link a record of $.data.pos, and an interactive
     * wall that is not draggable and whose press sets the record's pressed field. The SVG one also has a repeat of
     * draggable seats whose x and y link their records
     */
    const drawingOf = (renderer: 'svg' | 'canvas', record: string): Record<string, unknown> => ({
        component: 'drawing',
        _title: `Floor plan (${renderer})`,
        renderer,
        viewBox: { x: 0, y: 0, width: 200, height: 100 },
        children: {
            block: {
                component: 'rect',
                '<-x': `$.data.pos.${record}.x`,
                '<-y': `$.data.pos.${record}.y`,
                width: 20,
                height: 20,
                fill: '#3366ff',
                interactive: true,
                draggable: 'both',
                _label: 'Block'
            },
            wall: {
                component: 'rect',
                x: 150,
                y: 60,
                width: 20,
                height: 20,
                fill: '#888888',
                interactive: true,
                _label: 'Wall',
                on: { press: [{ command: 'set', target: `$.data.pos.${record}.pressed`, value: 'yes' }] }
            },
            ...(renderer === 'svg' && {
                seats: {
                    component: 'drawRepeat',
                    '<-records': '$.data.seats',
                    row: { component: 'rect', width: 10, height: 10, '<-x': '$row.x', '<-y': '$row.y', fill: '#00aa00', interactive: true, draggable: 'both', '<-_label': '$row.name' }
                }
            })
        }
    });

    /** The value at a path of the running instance */
    async function valueAt(path: string): Promise<Record<string, unknown>> {
        return (await step(harness, 'ui_state_get', { app: 'floor', path })).body['value'] as Record<string, unknown>;
    }

    /** Waits until the value at a path passes the check, and gives it */
    async function valueWhen(path: string, check: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
        const result = await eventually(harness, 'ui_state_get', { app: 'floor', path }, (found) => check((found.body['value'] ?? {}) as Record<string, unknown>));
        return result.body['value'] as Record<string, unknown>;
    }

    /**
     * Page pixels per drawing unit of a drawing, measured on the block (20 units wide) in a page of the app at the
     * headless page's viewport: its SVG element, or its proxy button on canvas
     */
    async function scaleOf(drawing: string): Promise<number> {
        const preview = await call(harness.client, 'ui_preview', { app: 'floor' });
        const own = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
            await own.goto(String(preview.body['url']));
            const drawings = own.frameLocator('iframe').locator('ui-drawing[data-render="ready"]');
            await drawings.nth(1).waitFor();
            const width = await drawings.evaluateAll((hosts, path: string) => {
                    for (const host of hosts) {
                        const block = host.shadowRoot?.querySelector(`[data-shape-path="${path}.children.block"]`);
                        if (block) return block.getBoundingClientRect().width;
                    }
                    return 0;
                }, drawing);
            return width / 20;
        } finally {
            await own.close();
        }
    }

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        browser = await chromium.launch();
        await step(harness, 'ui_model_write', {
            model: 'spot',
            operations: [
                { op: 'set', field: 'x', type: 'number' },
                { op: 'set', field: 'y', type: 'number' },
                { op: 'set', field: 'writes', type: 'number' },
                { op: 'set', field: 'pressed', type: 'string' }
            ]
        });
        await step(harness, 'ui_data_write', {
            dataset: 'spots',
            model: 'spot',
            operations: [
                { op: 'set', path: 'b1', value: { x: 20, y: 20, writes: 0, pressed: 'no' } },
                { op: 'set', path: 'c1', value: { x: 20, y: 20, writes: 0, pressed: 'no' } }
            ]
        });
        await step(harness, 'ui_model_write', {
            model: 'seat',
            operations: [
                { op: 'set', field: 'name', type: 'string' },
                { op: 'set', field: 'x', type: 'number' },
                { op: 'set', field: 'y', type: 'number' }
            ]
        });
        await step(harness, 'ui_data_write', {
            dataset: 'seats',
            model: 'seat',
            operations: [
                { op: 'set', path: 's1', value: { name: 'One', x: 100, y: 20 } },
                { op: 'set', path: 's2', value: { name: 'Two', x: 140, y: 20 } }
            ]
        });
        await createApp(harness.client, 'floor', shellOf({ map: drawingOf('svg', 'b1'), plan: drawingOf('canvas', 'c1') }), {
            data: { pos: { dataset: 'spots' }, seats: { dataset: 'seats' } }
        });
        // Counts the writes of each block's x, so a drag that wrote while it moved would count more than one
        await step(harness, 'ui_logic_write', {
            app: 'floor',
            expectedRevision: 1,
            operations: ['b1', 'c1'].map((record) => ({
                op: 'set',
                unit: `rules.count_${record}`,
                value: { when: { path: `$.data.pos.${record}.x` }, do: [{ command: 'increment', target: `$.data.pos.${record}.writes` }] }
            }))
        });
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    it('should validate the drawings with their draggable shapes', async () => {
        // Act
        const validated = await call(harness.client, 'ui_validate', { app: 'floor' });

        // Assert
        expect(validated.body['valid']).toBe(true);
        expect(validated.body['errors']).toEqual([]);
    });

    it('should drag the draggable SVG rect by an offset, move it and write its position once', async () => {
        // Arrange
        const scale = await scaleOf(MAP);

        // Act
        const dragged = await call(harness.client, 'ui_interact', { app: 'floor', actions: [{ action: 'drag', path: `${MAP}.children.block`, value: '+40,+20' }] });
        const moved = await valueWhen('$.data.pos.b1', (value) => value['writes'] === 1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const settled = await valueAt('$.data.pos.b1');

        // Assert: a real pointer is not rounded, so the position is near 20 + offset / scale
        expect(dragged.isError).toBe(false);
        expect(dragged.body['errors']).toEqual([]);
        expect(scale).toBeGreaterThan(0);
        expect(Math.abs((moved['x'] as number) - (20 + 40 / scale))).toBeLessThan(0.5);
        expect(Math.abs((moved['y'] as number) - (20 + 20 / scale))).toBeLessThan(0.5);
        expect(settled['writes']).toBe(1);
        expect(settled['pressed']).toBe('no');
    });

    it('should drag a repeat copy by an offset and change its record, not the other records', async () => {
        // Arrange
        const scale = await scaleOf(MAP);

        // Act
        const dragged = await call(harness.client, 'ui_interact', { app: 'floor', actions: [{ action: 'drag', path: `${MAP}.children.seats.rows.s2`, value: '+0,+30' }] });
        const seats = await valueWhen('$.data.seats', (value) => ((value['s2'] as { y?: number } | undefined)?.y ?? 20) > 21);

        // Assert
        expect(dragged.isError).toBe(false);
        const two = seats['s2'] as { name: string; x: number; y: number };
        expect(two.name).toBe('Two');
        expect(Math.abs(two.x - 140)).toBeLessThan(0.5);
        expect(Math.abs(two.y - (20 + 30 / scale))).toBeLessThan(0.5);
        expect(seats['s1']).toEqual({ name: 'One', x: 100, y: 20 });
    });

    it('should refuse to drag a shape that is not draggable, say so, and write nothing', async () => {
        // Arrange
        const before = await valueAt('$.data.pos');

        // Act
        const svg = await call(harness.client, 'ui_interact', { app: 'floor', actions: [{ action: 'drag', path: `${MAP}.children.wall`, value: '-40,-20' }] });
        const canvas = await call(harness.client, 'ui_interact', { app: 'floor', actions: [{ action: 'drag', path: `${PLAN}.children.wall`, value: '-40,-20' }] });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = await valueAt('$.data.pos');

        // Assert
        for (const [result, path] of [
            [svg, `${MAP}.children.wall`],
            [canvas, `${PLAN}.children.wall`]
        ] as const) {
            expect(result.isError).toBe(true);
            const error = (result.body['results'] as { error?: string }[])[0]?.error ?? '';
            expect(error).toContain(`${path} is a shape (rect) that is not draggable, so it was not dragged and its position is unchanged`);
            expect(error).toContain('interactive: true and draggable');
        }
        // No write, and no press either (the wall's press would set pressed)
        expect(after).toEqual(before);
    });

    it('should drag the draggable canvas rect by an offset, pressing on the canvas beneath its proxy, and write its position once', async () => {
        // Arrange
        const scale = await scaleOf(PLAN);

        // Act
        const dragged = await call(harness.client, 'ui_interact', { app: 'floor', actions: [{ action: 'drag', path: `${PLAN}.children.block`, value: '+40,+0' }] });
        const moved = await valueWhen('$.data.pos.c1', (value) => value['writes'] === 1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const settled = await valueAt('$.data.pos.c1');

        // Assert
        expect(dragged.isError).toBe(false);
        expect(scale).toBeGreaterThan(0);
        expect(Math.abs((moved['x'] as number) - (20 + 40 / scale))).toBeLessThan(0.5);
        expect(Math.abs((moved['y'] as number) - 20)).toBeLessThan(0.5);
        expect(settled['writes']).toBe(1);
        expect(settled['pressed']).toBe('no');
    });

    it('should press a canvas shape with ui_interact click through its proxy', async () => {
        // Act
        const clicked = await call(harness.client, 'ui_interact', { app: 'floor', actions: [{ action: 'click', path: `${PLAN}.children.wall` }] });
        const pressed = await valueWhen('$.data.pos.c1', (value) => value['pressed'] === 'yes');

        // Assert
        expect(clicked.isError).toBe(false);
        expect(pressed['pressed']).toBe('yes');
        expect((await valueAt('$.data.pos.b1'))['pressed']).toBe('no');
    });
});

/** The colour at a point of a PNG given as fractions of its width and height, and its number of different colours */
async function readPixelAt(page: Page, result: ToolResult, fx: number, fy: number): Promise<{ colour: [number, number, number]; colours: number }> {
    const data = result.images[0]?.data ?? '';
    return page.evaluate(
        async ({ base64, fx, fy }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d') as CanvasRenderingContext2D;
            context.drawImage(image, 0, 0);
            const { data: pixels } = context.getImageData(0, 0, image.width, image.height);
            const colours = new Set<number>();
            for (let index = 0; index < pixels.length; index += 4) colours.add(((pixels[index] as number) << 16) | ((pixels[index + 1] as number) << 8) | (pixels[index + 2] as number));
            const at = (Math.floor(fy * image.height) * image.width + Math.floor(fx * image.width)) * 4;
            const colour: [number, number, number] = [pixels[at] as number, pixels[at + 1] as number, pixels[at + 2] as number];
            return { colour, colours: colours.size };
        },
        { base64: data, fx, fy }
    );
}

describe.skipIf(!installed)('the chart on canvas through the agent tools: G2.3 of the graphics epic 2 (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    let blank: Page;
    const CHART = '$.app.children.sales';

    /** A bar chart of two months on canvas; the second bar is the tallest, so its centre is well inside it */
    const chart = {
        component: 'chart',
        renderer: 'canvas',
        _title: 'Sales',
        legend: 'none',
        x: 'month',
        series: { revenue: { field: 'revenue', _label: 'Revenue' } },
        records: [
            { month: 'Jan', revenue: 1000 },
            { month: 'Feb', revenue: 3000 }
        ]
    };

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        browser = await chromium.launch();
        blank = await browser.newPage();
        await createApp(harness.client, 'sales', shellOf({ sales: chart }));
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    it('should screenshot a canvas chart that is not blank and has the bar token colour at the bar centre', async () => {
        // Arrange: where the tall bar is in the chart and the colour its token paints, read from a page of the same app
        const preview = await call(harness.client, 'ui_preview', { app: 'sales' });
        const own = await browser.newPage();
        await own.goto(String(preview.body['url']));
        const probe = await own
            .frameLocator('iframe')
            .locator('ui-chart[data-render="ready"]')
            .evaluate((host) => {
                const root = host.shadowRoot as ShadowRoot;
                const canvas = root.querySelector('.plot > canvas') as HTMLCanvasElement;
                const bar = root.querySelector('.proxies > [data-point="bar:revenue:1"]') as HTMLElement;
                const outer = host.getBoundingClientRect();
                const box = bar.getBoundingClientRect();
                const swatch = document.createElement('canvas');
                swatch.width = 1;
                swatch.height = 1;
                const context = swatch.getContext('2d') as CanvasRenderingContext2D;
                context.fillStyle = getComputedStyle(canvas).getPropertyValue('--ui-color-data-categorical-1').trim();
                context.fillRect(0, 0, 1, 1);
                const [r = 0, g = 0, b = 0] = Array.from(context.getImageData(0, 0, 1, 1).data);
                return { fx: (box.left + box.width / 2 - outer.left) / outer.width, fy: (box.top + box.height / 2 - outer.top) / outer.height, token: [r, g, b] };
            });
        await own.close();

        // Act
        const shot = await call(harness.client, 'ui_screenshot', { app: 'sales', path: CHART });
        const pixels = await readPixelAt(blank, shot, probe.fx, probe.fy);

        // Assert
        expect(shot.isError).toBe(false);
        expect(shot.body['target']).toBe(CHART);
        expect(shot.body['pending']).toBeUndefined();
        expect(pixels.colours).toBeGreaterThan(2);
        pixels.colour.forEach((channel, index) => expect(Math.abs(channel - (probe.token[index] as number))).toBeLessThanOrEqual(2));
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

describe.skipIf(!installed)('paintField saving through the live view (G2.8 of the graphics epic 2, Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    const SIGN = { component: 'paintField', _label: 'Signature', width: 200, height: 100, colors: ['#ff0000'], sizes: [8] };

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

    /** The file reference the field holds in the server's state of the app, or undefined */
    async function savedRef(app: string): Promise<{ id: string; name: string; size: number; type: string } | undefined> {
        const state = await call(harness.client, 'ui_state_get', { app });
        const find = (value: unknown): { id: string; name: string; size: number; type: string } | undefined => {
            if (typeof value !== 'object' || value === null) return undefined;
            const entry = value as Record<string, unknown>;
            if (entry['type'] === 'image/png' && typeof entry['id'] === 'string') return entry as { id: string; name: string; size: number; type: string };
            for (const child of Object.values(entry)) {
                const found = find(child);
                if (found) return found;
            }
            return undefined;
        };
        return find(state.body['state']);
    }

    /** Waits until the server's state holds a saved painting other than `previous` and gives its reference */
    async function nextSave(app: string, previous: string | undefined): Promise<{ id: string; name: string; size: number; type: string }> {
        const deadline = Date.now() + 15_000;
        for (;;) {
            const found = await savedRef(app);
            if (found && found.id !== previous) return found;
            if (Date.now() > deadline) throw new Error(`No new save; the state holds ${JSON.stringify(found)}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    /** Draws a horizontal stroke across the field's canvas at the fraction `at` of its height */
    async function drawStroke(page: Page, at: number): Promise<void> {
        const box = await page.frameLocator('iframe').locator('canvas.canvas').boundingBox();
        if (!box) throw new Error('the canvas is not rendered');
        const y = box.y + box.height * at;
        await page.mouse.move(box.x + box.width * 0.1, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.5, y, { steps: 4 });
        await page.mouse.move(box.x + box.width * 0.9, y, { steps: 4 });
        await page.mouse.up();
    }

    /** The PNG files the app stores, as the test server's file repository lists them */
    async function storedPngs(appId: string): Promise<readonly string[]> {
        const files = await new FileUiFileRepository(new PartFolders(data.dir), new KeyedLock()).list(appId);
        return files.filter((file) => file.type === 'image/png').map((file) => file.id);
    }

    it('should save a painting the server serves back as a PNG, keep one file over ten saves and keep it past the sweep', { timeout: 120_000 }, async () => {
        // Arrange
        const app = await createApp(harness.client, 'paint', shellOf({ sign: SIGN }));
        const page = await browser.newPage();
        await page.goto(`${harness.server.origin}/apps/${app.id}`);
        await page.waitForSelector('body[data-status="ready"][data-sync="online"]');
        await page.frameLocator('iframe').locator('canvas.canvas').waitFor();

        // Act: one stroke, then the pause
        await drawStroke(page, 0.5);
        const first = await nextSave(app.name, undefined);
        const response = await fetch(`${harness.server.origin}/apps/${app.id}/files/${first.id}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const pixels = await page.evaluate(async (base64: string) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d') as CanvasRenderingContext2D;
            context.drawImage(image, 0, 0);
            return { centre: [...context.getImageData(100, 50, 1, 1).data], corner: [...context.getImageData(2, 2, 1, 1).data] };
        }, bytes.toString('base64'));

        // Act: nine more saves
        let last = first;
        for (let index = 1; index < 10; index += 1) {
            await drawStroke(page, 0.1 + index * 0.08);
            last = await nextSave(app.name, last.id);
        }
        await expect.poll(() => storedPngs(app.id), { timeout: 10_000 }).toEqual([last.id]);

        // Act: a day passes and another upload runs the sweep
        const index = new PartFolders(data.dir).filesIndex(app.id);
        const entries = JSON.parse(await readFile(index, 'utf8')) as { createdAt: string }[];
        const old = new Date(Date.now() - UNREFERENCED_FILE_GRACE_MS - 60_000).toISOString();
        await writeFile(index, JSON.stringify(entries.map((entry) => ({ ...entry, createdAt: old }))));
        const trigger = new FormData();
        trigger.append('file', new Blob([new Uint8Array(Buffer.from('trigger'))]), 'trigger.txt');
        const uploaded = await fetch(`${harness.server.origin}/apps/${app.id}/files`, { method: 'POST', body: trigger });
        const kept = await fetch(`${harness.server.origin}/apps/${app.id}/files/${last.id}`);

        // Assert
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('image/png');
        expect(first).toMatchObject({ name: 'Signature.png', type: 'image/png', size: bytes.length });
        expect(bytes.subarray(1, 4).toString()).toBe('PNG');
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([200, 100]);
        expect(pixels.centre).toEqual([255, 0, 0, 255]);
        expect(pixels.corner[3]).toBe(0);
        expect(uploaded.status).toBe(201);
        expect(kept.status).toBe(200);
        await page.close();
    });
});

describe.skipIf(!installed)('a drawImage of an uploaded file through the agent tools: G1.9b of the graphics epic 1 (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    let blank: Page;
    let appId = '';
    const SVG_PLAN = '$.app.children.plan';
    const CANVAS_PLAN = '$.app.children.canvasPlan';

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        browser = await chromium.launch();
        blank = await browser.newPage();
        appId = (await createApp(harness.client, 'plans', shellOf({}))).id;
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    /** A PNG of 40 by 20 pixels, green on the left half and blue on the right half, made in the blank page */
    async function splitPng(): Promise<Buffer> {
        const base64 = await blank.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 40;
            canvas.height = 20;
            const context = canvas.getContext('2d') as CanvasRenderingContext2D;
            context.fillStyle = '#00ff00';
            context.fillRect(0, 0, 20, 20);
            context.fillStyle = '#0000ff';
            context.fillRect(20, 0, 20, 20);
            return canvas.toDataURL('image/png').split(',')[1] ?? '';
        });
        return Buffer.from(base64, 'base64');
    }

    it('should screenshot the pixels of an uploaded PNG in a drawImage, in SVG and on canvas', { timeout: 60_000 }, async () => {
        // Arrange: the file is uploaded as a fileField would upload it
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(await splitPng())], { type: 'image/png' }), 'plan.png');
        const uploaded = await fetch(`${harness.server.origin}/apps/${appId}/files`, { method: 'POST', body: form });
        const reference = (await uploaded.json()) as { id: string; name: string; size: number; type: string };
        const drawingOf = (renderer: string) => ({
            component: 'drawing',
            renderer,
            _title: 'Floor plan',
            viewBox: { x: 0, y: 0, width: 200, height: 100 },
            children: { backdrop: { component: 'drawImage', src: reference, x: 0, y: 0, width: 200, height: 100, fit: 'stretch' } }
        });

        // Act
        const written = await writeShell(harness, 'plans', 1, [
            { op: 'set', path: 'root.children.plan', value: drawingOf('svg') },
            { op: 'set', path: 'root.children.canvasPlan', value: drawingOf('canvas') }
        ]);
        const validated = await call(harness.client, 'ui_validate', { app: 'plans' });
        const shots = [await call(harness.client, 'ui_screenshot', { app: 'plans', path: SVG_PLAN }), await call(harness.client, 'ui_screenshot', { app: 'plans', path: CANVAS_PLAN })];

        // Assert
        expect(uploaded.status).toBe(201);
        expect(reference.type).toBe('image/png');
        expect(written.isError).toBe(false);
        expect(validated.body['errors']).toEqual([]);
        // The drawing is wider than tall, so its viewBox is fitted (contain) in the middle: left and right of the centre
        // are the picture's two halves
        for (const shot of shots) {
            expect(shot.isError).toBe(false);
            expect(shot.body['pending']).toBeUndefined();
            const left = await readPixelAt(blank, shot, 0.45, 0.5);
            const right = await readPixelAt(blank, shot, 0.55, 0.5);
            left.colour.forEach((channel, index) => expect(Math.abs(channel - ([0, 255, 0][index] as number))).toBeLessThanOrEqual(2));
            right.colour.forEach((channel, index) => expect(Math.abs(channel - ([0, 0, 255][index] as number))).toBeLessThanOrEqual(2));
        }
    });
});

/** A pure red box lit head-on by a directional light of intensity 1 (G3.5's render test): red, plus a little white */
const LIT_RED = [252, 27, 27] as const;
/** How far a pixel of a WebGL capture may be from the expected colour, per channel: software rendering differs a little by machine */
const WEBGL_TOLERANCE = 12;

/** True when a colour is within `WEBGL_TOLERANCE` of the expected one in every channel */
function isNear(actual: readonly number[], expected: readonly number[]): boolean {
    return expected.every((value, channel) => Math.abs((actual[channel] ?? -1) - value) <= WEBGL_TOLERANCE);
}

/** Asserts that a colour is within `WEBGL_TOLERANCE` of the expected one in every channel */
function expectNear(actual: readonly number[], expected: readonly number[]): void {
    expect(isNear(actual, expected), `[${actual.join(', ')}], expected [${expected.join(', ')}] within ${WEBGL_TOLERANCE}`).toBe(true);
}

/**
 * The release 3A scene an agent writes from the kit vocabulary: a titled `scene3d` with orbit controls, a light and a
 * red box, no camera (the default camera frames the box) and no environment light, so the box's centre is `LIT_RED`.
 * The background is left unset, so it is the `scene3d.background` token
 */
const VIEWER = {
    component: 'scene3d',
    _title: 'Red box',
    controls: 'orbit',
    environment: 'none',
    children: {
        sun: { component: 'light', kind: 'directional', position: [0, 0, 10], target: [0, 0, 0] },
        box: { component: 'mesh', geometry: { kind: 'box' }, material: { color: '#ff0000' } }
    }
};

/** One thing the instrumented page saw of a scene: a context event with `data-render` at that moment, or a change of `data-render` */
interface SceneLogEntry {
    readonly kind: 'lost' | 'restored' | 'render';
    readonly render: string | null;
    readonly at: number;
}

/**
 * A page script that records, in every frame, the WebGL context events of each canvas that gets a WebGL context and
 * the `data-render` changes of the element whose shadow root holds it (the `scene3d`), in `window.__sceneLog`
 */
function recordSceneLog(): void {
    const log: { kind: string; render: string | null; at: number }[] = [];
    (window as unknown as { __sceneLog: typeof log }).__sceneLog = log;
    const original = HTMLCanvasElement.prototype.getContext;
    const watched = new WeakSet<HTMLCanvasElement>();
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        const context = (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
        if (context !== null && type.startsWith('webgl') && !watched.has(this)) {
            watched.add(this);
            const root = this.getRootNode();
            const host = root instanceof ShadowRoot ? root.host : undefined;
            const render = (): string | null => host?.getAttribute('data-render') ?? null;
            this.addEventListener('webglcontextlost', () => log.push({ kind: 'lost', render: render(), at: performance.now() }));
            this.addEventListener('webglcontextrestored', () => log.push({ kind: 'restored', render: render(), at: performance.now() }));
            if (host !== undefined) {
                new MutationObserver(() => log.push({ kind: 'render', render: render(), at: performance.now() })).observe(host, { attributes: true, attributeFilter: ['data-render'] });
            }
        }
        return context;
    } as typeof original;
}

/** A PNG as the tools return it, for `readPixelAt` */
function asResult(png: Buffer): ToolResult {
    return { isError: false, body: {}, images: [{ data: png.toString('base64'), mimeType: 'image/png' }] };
}

describe.skipIf(!installed)('a 3D scene through the agent tools: G3.10 of the graphics epic 3 (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    let blank: Page;
    let viewerId = '';
    const SCENE = '$.app.children.viewer';

    beforeAll(async () => {
        data = await tempData();
        // A server of its own: its headless browser starts at the first screenshot below, so that capture is of the
        // first page after launch, whose WebGL contexts Chromium loses once and restores (G3.1)
        harness = await httpHarness(data.dir);
        browser = await chromium.launch();
        blank = await browser.newPage();
        viewerId = (await createApp(harness.client, 'viewer', shellOf({}))).id;
        await createApp(harness.client, 'plain', shellOf({ note: { component: 'text', _text: 'No scene here' } }));
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    it('should accept the scene from the kit vocabulary and validate it', async () => {
        // Arrange: what the agent reads before it writes
        const components = await Promise.all(['scene3d', 'light', 'mesh'].map((component) => call(harness.client, 'ui_component_get', { name: component })));

        // Act
        const written = await writeShell(harness, 'viewer', 1, [{ op: 'set', path: 'root.children.viewer', value: VIEWER }]);
        const validated = await call(harness.client, 'ui_validate', { app: 'viewer' });

        // Assert
        expect(components.map((component) => component.isError)).toEqual([false, false, false]);
        expect(written.isError).toBe(false);
        expect(validated.body['valid']).toBe(true);
        expect(validated.body['errors']).toEqual([]);
    });

    it('should screenshot the lit box on the background in the first page of the headless browser, with no pending scene', async () => {
        // Act: the first call that starts the server's headless browser
        const started = performance.now();
        const shot = await call(harness.client, 'ui_screenshot', { app: 'viewer', path: SCENE });
        const took = performance.now() - started;
        const centre = await readPixelAt(blank, shot, 0.5, 0.5);
        console.log(`G3.10 performance: ui_screenshot of a scene in a newly started headless browser took ${Math.round(took)} ms`);

        // Assert
        expect(shot.isError).toBe(false);
        expect(shot.body['target']).toBe(SCENE);
        expect(shot.body['scenes']).toBeUndefined();
        expect(shot.body['pending']).toBeUndefined();
        expect(centre.colours).toBeGreaterThan(2);
        expectNear(centre.colour, LIT_RED);
    });

    it('should capture the WebGL canvas in a page screenshot, with no preserveDrawingBuffer', async () => {
        // Arrange: where the scene is in the page, read from a page of the same app at the same viewport
        const own = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await own.goto(`${harness.server.origin}/apps/${viewerId}`);
        const scene = own.frameLocator('iframe').locator('ui-scene3d[data-render="ready"]');
        const box = await scene.boundingBox();
        const preserved = await scene.evaluate((element) => {
            const canvas = element.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
            return (canvas.getContext('webgl2') as WebGL2RenderingContext).getContextAttributes()?.preserveDrawingBuffer;
        });
        await own.close();
        if (box === null) throw new Error('the scene has no box');

        // Act
        const started = performance.now();
        const shot = await call(harness.client, 'ui_screenshot', { app: 'viewer' });
        console.log(`G3.10 performance: ui_screenshot of the page with a scene, browser already started, took ${Math.round(performance.now() - started)} ms`);
        const centre = await readPixelAt(blank, shot, (box.x + box.width / 2) / 1280, (box.y + box.height / 2) / 800);

        // Assert
        expect(preserved).toBe(false);
        expect(shot.isError).toBe(false);
        expect(shot.body['target']).toBe('page');
        expect(shot.body['scenes']).toBeUndefined();
        expectNear(centre.colour, LIT_RED);
    });

    it('should draw the background token of the dark mode in a mode: "dark" screenshot', async () => {
        // Arrange: the light background token, as the scene's host paints it
        const own = await browser.newPage();
        await own.goto(`${harness.server.origin}/apps/${viewerId}`);
        const token = rgbOf(
            await own
                .frameLocator('iframe')
                .locator('ui-scene3d[data-render="ready"]')
                .evaluate((element) => getComputedStyle(element.shadowRoot?.querySelector('.scene') as HTMLElement).backgroundColor)
        );
        await own.close();
        const light = await call(harness.client, 'ui_screenshot', { app: 'viewer', path: SCENE });

        // Act
        const dark = await call(harness.client, 'ui_screenshot', { app: 'viewer', path: SCENE, mode: 'dark' });
        const [lightCorner, darkCorner, darkCentre] = await Promise.all([readPixelAt(blank, light, 0.02, 0.05), readPixelAt(blank, dark, 0.02, 0.05), readPixelAt(blank, dark, 0.5, 0.5)]);

        // Assert
        expect(dark.isError).toBe(false);
        expect(dark.body['mode']).toBe('dark');
        expect(dark.body['scenes']).toBeUndefined();
        expectNear(lightCorner.colour, token);
        expect(isNear(darkCorner.colour, lightCorner.colour), `dark corner [${darkCorner.colour.join(', ')}] is the light background`).toBe(false);
        expectNear(darkCentre.colour, LIT_RED);
    });

    it('should keep the scene pending from a lost context until the frame after the restore, in the first page after launch', async () => {
        // Arrange: a browser of its own, whose first page is the scene (G3.1: its contexts are lost once and restored)
        const fresh = await chromium.launch({ headless: true });
        try {
            const page = await fresh.newPage();
            await page.addInitScript(recordSceneLog);
            const started = performance.now();

            // Act
            await page.goto(`${harness.server.origin}/apps/${viewerId}`);
            const scene = page.frameLocator('iframe').locator('ui-scene3d[data-render="ready"]');
            await scene.waitFor();
            const firstReady = performance.now() - started;
            // Time for a loss that comes after the first frame, and for its restore and redraw
            await page.waitForTimeout(1_000);
            await scene.waitFor();
            const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
            const log = ((await frame?.evaluate(() => (window as unknown as { __sceneLog: SceneLogEntry[] }).__sceneLog)) ?? []) as SceneLogEntry[];
            const centre = await readPixelAt(blank, asResult(await scene.screenshot({ type: 'png' })), 0.5, 0.5);
            const losses = log.filter((entry) => entry.kind === 'lost').length;
            console.log(`G3.10 performance: a small scene in the first page after launch was ready ${Math.round(firstReady)} ms after the page load started; contexts lost and restored: ${losses}`);

            // Assert: the log saw the scene; pending at each loss, never ready between a loss and its restore, ready
            // after the last restore. Whether Chromium loses the context here depends on how soon after the start the
            // scene makes it (measured in G3.10: a context made 60 ms after the page opened was lost and restored a second
            // later, one made after 300 ms was not); the fake chunk test in
            // chunk3d.integration.test.ts forces a loss through ui_screenshot
            expect(log.some((entry) => entry.kind === 'render' && entry.render === 'ready')).toBe(true);
            let lost = false;
            for (const entry of log) {
                if (entry.kind === 'lost') {
                    expect(entry.render).toBe('pending');
                    lost = true;
                }
                if (entry.kind === 'restored') lost = false;
                if (entry.kind === 'render' && lost) expect(entry.render).toBe('pending');
            }
            const lastRestore = log.map((entry) => entry.kind).lastIndexOf('restored');
            if (lastRestore >= 0) expect(log.slice(lastRestore).some((entry) => entry.kind === 'render' && entry.render === 'ready')).toBe(true);
            expectNear(centre.colour, LIT_RED);
        } finally {
            await fresh.close();
        }
    });

    it('should never load the chunk for an app with no scene, and load it for the scene', async () => {
        // Arrange
        const counted = async (url: string): Promise<{ chunk: string | null; requests: string[] }> => {
            const page = await browser.newPage();
            const requests: string[] = [];
            page.on('request', (request) => requests.push(new URL(request.url()).pathname));
            await page.goto(url);
            await page.waitForSelector('body[data-status="ready"]');
            // Time for a late request, had anything asked for the chunk
            await page.waitForTimeout(500);
            const chunk = await page.getAttribute('body', 'data-chunk-3d');
            await page.close();
            return { chunk, requests };
        };
        const plain = String((await call(harness.client, 'ui_preview', { app: 'plain' })).body['url']);

        // Act
        const withoutScene = await counted(plain);
        const withScene = await counted(`${harness.server.origin}/apps/${viewerId}`);

        // Assert: the workspace's built chunk is served, and asked for only by the scene
        expect(withoutScene.chunk).toMatch(/^[0-9a-f]{16}$/);
        expect(withoutScene.requests).not.toContain(`/runtime/${withoutScene.chunk}.js`);
        expect(withScene.requests).toContain(`/runtime/${withScene.chunk}.js`);
    });
});

describe.skipIf(!installed)('a 3D scene in a headless browser with no WebGL: G3.10 of the graphics epic 3 (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    let blank: Page;
    const SCENE = '$.app.children.viewer';

    beforeAll(async () => {
        data = await tempData();
        // --disable-3d-apis: the browser starts, and every getContext('webgl2') and ('webgl') answers null
        harness = await httpHarness(data.dir, undefined, { browserArgs: ['--disable-3d-apis'] });
        browser = await chromium.launch();
        blank = await browser.newPage();
        await createApp(harness.client, 'viewer', shellOf({ viewer: { ...VIEWER, _fallback: 'No 3D in this browser' } }));
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    it('should show _fallback and still return the screenshot without waiting for the scene', async () => {
        // Arrange: a page of the app in a browser with no WebGL either, to see what the headless page shows
        const own = await chromium.launch({ headless: true, args: ['--disable-3d-apis'] });
        const page = await own.newPage();

        // Act
        const started = performance.now();
        const shot = await call(harness.client, 'ui_screenshot', { app: 'viewer', path: SCENE });
        const took = performance.now() - started;
        const centre = await readPixelAt(blank, shot, 0.5, 0.5);
        await page.goto(String((await call(harness.client, 'ui_preview', { app: 'viewer' })).body['url']));
        const scene = page.frameLocator('iframe').locator('ui-scene3d[data-render="ready"]');
        const shown = await scene.evaluate((element) => ({
            fallback: element.hasAttribute('data-fallback'),
            text: element.shadowRoot?.querySelector('.fallback')?.textContent ?? '',
            display: getComputedStyle(element.shadowRoot?.querySelector('.fallback') as HTMLElement).display,
            canvas: element.shadowRoot?.querySelector('canvas') !== null
        }));
        await own.close();

        // Assert: the capture did not wait for the scene, and shows the fallback text on the background, not the box
        expect(shot.isError).toBe(false);
        expect(shot.body['target']).toBe(SCENE);
        expect(shot.body['scenes']).toBeUndefined();
        expect(took).toBeLessThan(10_000);
        expect(centre.colours).toBeGreaterThan(2);
        expect(isNear(centre.colour, LIT_RED)).toBe(false);
        expect(shown).toEqual({ fallback: true, text: 'No 3D in this browser', display: 'grid', canvas: false });
    });
});

describe.skipIf(!installed)('WebGL in the headless browser the preview starts: G3.10 of the graphics epic 3 (Chromium through Playwright)', () => {
    it('should give WebGL2 in Chromium launched as BrowserPreview launches it, with no arguments', async () => {
        // Arrange: G3.1 found no arguments necessary; a Chromium or Playwright update that drops WebGL fails here
        const fresh = await chromium.launch({ headless: true });
        try {
            const page = await fresh.newPage();

            // Act
            const webgl = await page.evaluate(() => {
                const context = document.createElement('canvas').getContext('webgl2');
                return { webgl2: context !== null, renderer: context === null ? '' : String(context.getParameter(context.RENDERER)) };
            });

            // Assert
            expect(webgl.webgl2, 'headless Chromium gives no WebGL2: 3D scenes would show their fallback in ui_screenshot').toBe(true);
            expect(webgl.renderer).not.toBe('');
        } finally {
            await fresh.close();
        }
    });
});
