import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { FORM_DOCUMENT, call, httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const installed = await BrowserPreview.isInstalled();

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

    it('should read the typed value live from the page', async () => {
        // Act
        const state = await call(harness.client, 'ui_state_get', { appId });

        // Assert
        expect(state.body['source']).toBe('live');
        expect(JSON.stringify(state.body['snapshot'])).toContain('a@b.test');
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
        expect(state.body['source']).toBe('live');
        expect((state.body['snapshot'] as { data: unknown }).data).toMatchObject({ tasks: { t1: { title: 'first' }, t2: { title: 'second' } } });
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

    it('should keep what a view computed when later state sets follow one another', async () => {
        // Arrange: a stat formats its linked value into the runtime property shown, which the view reports back
        const created = await call(harness.client, 'ui_app_create', {
            name: 'totals',
            document: {
                app: { component: 'page', children: { total: { component: 'stat', format: 'number', '<-value': '$.data.totals.month' } } },
                data: { totals: { month: 1, count: 1 }, other: { n: 0 }, draft: { text: 'x' } }
            }
        });
        const totalsAppId = created.body['appId'] as string;
        await call(harness.client, 'ui_preview', { appId: totalsAppId });

        await call(harness.client, 'ui_state_set', { appId: totalsAppId, path: '$.data.totals', value: { month: 2, count: 2 } });
        //the view reports its state at most once a second: let a report with shown "2" be stored
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Act: the writes an agent makes after an add, one after another, faster than the view reports
        await call(harness.client, 'ui_state_set', { appId: totalsAppId, path: '$.data.totals', value: { month: 3, count: 3 } });
        await call(harness.client, 'ui_state_set', { appId: totalsAppId, path: '$.data.other.n', value: 3 });
        await call(harness.client, 'ui_state_set', { appId: totalsAppId, path: '$.data.draft', value: { text: '' } });
        await call(harness.client, 'ui_preview', { appId: totalsAppId });
        const state = await call(harness.client, 'ui_state_get', { appId: totalsAppId });

        // Assert
        const snapshot = state.body['snapshot'] as { app: { children: { total: { shown: string } } }; data: { draft: unknown } };
        expect(state.body['source']).toBe('live');
        expect(snapshot.app.children.total.shown).toBe('3');
        expect(snapshot.data.draft).toEqual({ text: '' });
    });
});
