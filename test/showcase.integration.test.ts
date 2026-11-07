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
        const at = '$.app.header.children.actions.children';
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

    it('should report no runtime error for the whole visit', async () => {
        // Act
        const state = await call(harness.client, 'ui_state_get', { app: SHOWCASE_APP, path: '$.route' });

        // Assert
        expect(state.isError, JSON.stringify(state.body)).toBe(false);
        expect(problemsIn((state.body['preview'] as { errors: unknown[] }).errors)).toEqual([]);
    });
});
