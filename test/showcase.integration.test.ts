import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORY_ORDER } from '../scripts/buildShowcase.mjs';
import { SHOWCASE_APP } from '../src/config/showcase.js';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { call, httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const installed = await BrowserPreview.isInstalled();

/** The screens of the showcase: home, then one per category */
const SCREENS: readonly string[] = ['home', ...CATEGORY_ORDER];

/** The problems of a preview report, warnings included: a contrast note of a library preset is a defect of the preset */
const problemsIn = (problems: unknown): unknown[] => problems as unknown[];

describe.skipIf(!installed)('the component showcase in the headless browser', () => {
    let data: TempData;
    let harness: HttpHarness;
    let cursor: number | undefined;

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir, undefined, { showcase: true });
    });

    afterAll(async () => {
        await harness.close();
        await data.cleanup();
    });

    it.each(SCREENS)('should render the %s screen with no runtime error or warning and take a screenshot', async (screen) => {
        // Act
        const preview = await call(harness.client, 'ui_preview', { app: SHOWCASE_APP, screen });
        const shot = await call(harness.client, 'ui_screenshot', { app: SHOWCASE_APP, screen, fullPage: true });
        const events = await call(harness.client, 'ui_events_read', { app: SHOWCASE_APP, ...(cursor !== undefined && { since: cursor }) });
        cursor = events.body['cursor'] as number;

        // Assert
        expect(preview.isError, JSON.stringify(preview.body)).toBe(false);
        expect(preview.body['rendered']).toBe(true);
        expect(problemsIn(preview.body['errors'])).toEqual([]);
        expect(shot.isError, JSON.stringify(shot.body)).toBe(false);
        expect(shot.images).toHaveLength(1);
        expect(Buffer.from(shot.images[0]?.data ?? '', 'base64').subarray(1, 4).toString()).toBe('PNG');
        expect((events.body['events'] as { name: string }[]).filter((event) => event.name === 'logic.failed')).toEqual([]);
    });

    it('should keep the theme and mode the user picks in the instance, across a reload, and not a screenshot mode', async () => {
        // Arrange
        // The header is placed by every screen; the one of the home screen is picked, so the preview shows home first
        const at = '$.screens.home.children.header.children.actions.children';
        await call(harness.client, 'ui_preview', { app: SHOWCASE_APP, screen: 'home' });
        const active = async (): Promise<unknown> => {
            const state = await call(harness.client, 'ui_state_get', { app: SHOWCASE_APP });
            return (state.body['state'] as { theme?: { active?: unknown } }).theme?.active;
        };

        // Act
        const picked = await call(harness.client, 'ui_interact', {
            app: SHOWCASE_APP,
            actions: [
                { action: 'choose', path: `${at}.theme`, value: 'Moody' },
                { action: 'choose', path: `${at}.mode`, value: 'dark' }
            ]
        });
        await expect.poll(active).toEqual({ theme: 'showcase-moody', mode: 'dark' });
        await call(harness.client, 'ui_screenshot', { app: SHOWCASE_APP, mode: 'light' });
        const afterCapture = await active();
        await call(harness.client, 'ui_preview', { app: SHOWCASE_APP });
        const afterReload = await active();

        // Assert
        expect(picked.isError, JSON.stringify(picked.body)).toBe(false);
        expect(afterCapture).toEqual({ theme: 'showcase-moody', mode: 'dark' });
        expect(afterReload).toEqual({ theme: 'showcase-moody', mode: 'dark' });
    });

    it("should unassign a task moved back to To do, by the showcase's logic module", async () => {
        // Arrange
        await call(harness.client, 'ui_preview', { app: SHOWCASE_APP, screen: 'data' });
        const assignee = async (): Promise<unknown> => {
            const state = await call(harness.client, 'ui_state_get', { app: SHOWCASE_APP, path: '$.data.tasks.t3.assignee' });
            return state.body['value'];
        };
        expect(await assignee()).not.toBe('');

        // Act
        const moved = await call(harness.client, 'ui_data_write', { dataset: 'showcase-tasks', operations: [{ op: 'set', path: 't3.column', value: 'todo' }] });

        // Assert
        expect(moved.isError, JSON.stringify(moved.body)).toBe(false);
        await expect.poll(assignee).toBe('');
    });

    it('should report no runtime error for the whole visit', async () => {
        // Act
        const state = await call(harness.client, 'ui_state_get', { app: SHOWCASE_APP, path: '$.route' });

        // Assert
        expect(state.isError, JSON.stringify(state.body)).toBe(false);
        expect(problemsIn((state.body['preview'] as { errors: unknown[] }).errors)).toEqual([]);
    });
});

describe.skipIf(!installed)('the starter apps in the headless browser', () => {
    let data: TempData;
    let harness: HttpHarness;

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir, undefined, { showcase: true });
    });

    afterAll(async () => {
        await harness.close();
        await data.cleanup();
    });

    it('should open, minimize, restore and close a Lumen window, keeping what shows on the window and its taskbar button', async () => {
        // Arrange
        const app = 'lumen-desktop';
        const home = '$.screens.home.children';
        const task = `${home}.taskbar.children.tasks.children.notes`;
        await call(harness.client, 'ui_preview', { app, screen: 'home' });
        const read = async (path: string): Promise<unknown> => (await call(harness.client, 'ui_state_get', { app, path })).body['value'];
        const shown = async (): Promise<unknown> => ({
            window: await read(`${home}.surface.children.notes.hidden`),
            task: await read(`${task}.hidden`),
            variant: await read(`${task}.variant`)
        });
        const click = async (path: string): Promise<boolean> => (await call(harness.client, 'ui_interact', { app, actions: [{ action: 'click', path }] })).isError;

        // Nothing has written the window's own state yet: it is read from the definition
        const closedAtStart = await shown();

        // Act
        const opened = await click(`${home}.surface.children.icons.children.notes`);
        await expect.poll(shown).toEqual({ window: false, task: false, variant: 'soft' });
        const minimized = await click(task);
        await expect.poll(shown).toEqual({ window: true, task: false, variant: 'ghost' });
        const restored = await click(task);
        await expect.poll(shown).toEqual({ window: false, task: false, variant: 'soft' });
        // The close control is inside the window, not a node of its own: focus goes to the window's title, and five
        // Tabs later (snap left, snap right, minimize, maximize, close) Enter presses the control
        const closed = await call(harness.client, 'ui_interact', {
            app,
            actions: [{ action: 'focus', path: `${home}.surface.children.notes` }, ...Array.from({ length: 5 }, () => ({ action: 'key', value: 'Tab' })), { action: 'key', value: 'Enter' }]
        });
        await expect.poll(shown).toEqual({ window: true, task: true, variant: 'ghost' });
        const events = await call(harness.client, 'ui_events_read', { app });

        // Assert
        expect(closedAtStart).toEqual({ window: true, task: true, variant: 'ghost' });
        expect([opened, minimized, restored, closed.isError]).toEqual([false, false, false, false]);
        expect((events.body['events'] as { name: string }[]).filter((event) => event.name === 'logic.failed')).toEqual([]);
    });

    it('should label a new Northwind order with its number after a hash', async () => {
        // Arrange
        const app = 'northwind-ops';
        const content = '$.screens.create.children.content.children';
        await call(harness.client, 'ui_preview', { app, screen: 'create' });
        const labels = async (): Promise<unknown> => {
            const orders = (await call(harness.client, 'ui_state_get', { app, path: '$.data.orders' })).body['value'] as Record<string, { label: string; number: number }>;
            return Object.values(orders).map((order) => order.label === `#${order.number}`);
        };
        const before = ((await labels()) as boolean[]).length;

        // Act
        const created = await call(harness.client, 'ui_interact', {
            app,
            actions: [
                { action: 'select', path: `${content}.form.children.customer`, value: 'c001' },
                { action: 'select', path: `${content}.form.children.product`, value: 'chai' },
                { action: 'click', path: `${content}.actions.children.create` }
            ]
        });

        // Assert
        expect(created.isError, JSON.stringify(created.body)).toBe(false);
        await expect.poll(labels).toHaveLength(before + 1);
        expect(await labels()).not.toContain(false);
    });
});
