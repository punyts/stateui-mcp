import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { Browser, Frame, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_OWNER_ID } from '../src/config/createServices.js';
import type { UiPart, UiPartBodies } from '../src/domain/UiPart.js';
import { PartFolders } from '../src/infrastructure/storage/PartFolders.js';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const installed = await BrowserPreview.isInstalled();

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const ACCENT = '--ui-color-accent-base';

const theme = (accent: string): UiPartBodies['themes'] => deepFreeze({ tokens: { color: { accent: { base: accent } } } }) as unknown as UiPartBodies['themes'];

/** A shop with a store theme, a shell with a search field and two screens; the about screen has a note field */
const SHOP = deepFreeze({
    uses: { themes: ['store'] },
    start: 'home',
    shell: { component: 'page', children: { search: { component: 'textField', _label: 'Search' }, main: { component: 'outlet' } } },
    screens: {
        home: { root: { component: 'text', _text: 'Welcome home' } },
        about: { root: { component: 'form', children: { title: { component: 'text', _text: 'About the shop' }, note: { component: 'textField', _label: 'Note' } } } }
    }
}) as unknown as UiPartBodies['apps'];

/** Polls `read` until `check` passes or ten seconds are up, and returns the last value */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const value = await read().catch(() => undefined as T);
        if (check(value) || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/** The runtime frame of a view page */
function runtimeFrame(page: Page): Frame | undefined {
    return page.frames().find((frame) => frame !== page.mainFrame());
}

/** The accent token as the frame's elements see it: the first element that has the custom property */
async function accentOf(page: Page): Promise<string> {
    const frame = runtimeFrame(page);
    if (frame === undefined) return '';
    return frame.evaluate(
        (name) => [...document.querySelectorAll('*')].map((element) => getComputedStyle(element).getPropertyValue(name).trim()).find((value) => value !== '') ?? '',
        ACCENT
    );
}

/** The text the frame shows, through open shadow roots */
async function textOf(page: Page): Promise<string> {
    const frame = runtimeFrame(page);
    if (frame === undefined) return '';
    return frame.evaluate(() => {
        const walk = (root: ParentNode): string =>
            [...root.childNodes]
                .map((node) => {
                    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
                    if (!(node instanceof HTMLElement)) return '';
                    if (node.hidden) return '';
                    return (node.shadowRoot ? walk(node.shadowRoot) : '') + walk(node);
                })
                .join('');
        return walk(document.body);
    });
}

/** The values of the frame's inputs, through open shadow roots */
async function inputValues(page: Page): Promise<string[]> {
    const frame = runtimeFrame(page);
    if (frame === undefined) return [];
    return frame.evaluate(() => {
        const values: string[] = [];
        const walk = (root: ParentNode): void => {
            for (const element of root.querySelectorAll('*')) {
                if (element instanceof HTMLInputElement) values.push(element.value);
                if (element.shadowRoot) walk(element.shadowRoot);
            }
        };
        walk(document);
        return values;
    });
}

describe.skipIf(!installed)('the live view of an owner app (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    let app: UiPart<'apps'>;

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        const writePart = harness.server.services.useCases.writePart;
        if (writePart === undefined) throw new Error('The server has no part writes');
        for (const [kind, name, body] of [
            ['themes', 'store', theme('#204080')],
            ['apps', 'shop', SHOP]
        ] as const) {
            const written = await writePart.execute({ kind, name, body } as never);
            if (written.kind !== 'written') throw new Error(`${name}: ${JSON.stringify(written)}`);
        }
        const [shop] = await harness.server.services.instanceViews.appsShowing('apps', 'shop');
        if (shop === undefined) throw new Error('The shop was not stored');
        app = shop;
        browser = await chromium.launch();
    });

    afterAll(async () => {
        await browser?.close();
        await harness.close();
        await data.cleanup();
    });

    it('should show the assembled app at its start screen with the theme part applied', async () => {
        // Arrange
        const page = await browser.newPage();

        // Act
        await page.goto(`${harness.server.origin}/apps/${app.id}`);
        await page.waitForFunction(() => document.body.dataset['status'] === 'ready');
        const text = await eventually(() => textOf(page), (value) => value.includes('Welcome home'));
        const accent = await accentOf(page);
        await page.close();

        // Assert
        expect(text).toContain('Welcome home');
        expect(text).not.toContain('About the shop');
        expect(accent).toBe('#204080');
    });

    it('should reload an open view with the new token when the theme part is written', async () => {
        // Arrange
        const page = await browser.newPage();
        await page.goto(`${harness.server.origin}/apps/${app.id}`);
        await page.waitForFunction(() => document.body.dataset['status'] === 'ready');
        const writePart = harness.server.services.useCases.writePart;

        // Act
        const written = await writePart?.execute({ kind: 'themes', name: 'store', body: theme('#802040'), expectedRevision: 1 });
        const accent = await eventually(() => accentOf(page), (value) => value === '#802040');
        await page.close();

        // Assert
        expect(written?.kind).toBe('written');
        expect(accent).toBe('#802040');
    });

    it('should open the headless page at a given screen and keep the route in the instance', async () => {
        // Arrange
        const services = harness.server.services;
        const revision = services.instanceViews.revision(app.id) ?? 1;

        // Act
        const opened = await services.browser.open(app.id, revision, { screen: 'about' });
        const rendered = await eventually(
            () => services.browser.rendered(app.id, revision, '$.screens'),
            (nodes) => nodes?.some((node) => node.path.startsWith('$.screens.about') && node.visible) === true
        );
        const page = await browser.newPage();
        await page.goto(`${harness.server.origin}/apps/${app.id}`);
        await page.waitForFunction(() => document.body.dataset['status'] === 'ready');
        const text = await eventually(() => textOf(page), (value) => value.includes('About the shop'));
        await page.close();

        // Assert
        expect(opened.rendered).toBe(true);
        expect(rendered.filter((node) => node.visible).map((node) => node.path.split('.').slice(0, 3).join('.'))).toContain('$.screens.about');
        expect(text).toContain('About the shop');
        expect(text).not.toContain('Welcome home');
    });

    it('should sync a value typed on a screen to another view and store it in the instance', async () => {
        // Arrange
        const services = harness.server.services;
        const revision = services.instanceViews.revision(app.id) ?? 1;
        const page = await browser.newPage();
        await page.goto(`${harness.server.origin}/apps/${app.id}`);
        await page.waitForFunction(() => document.body.dataset['status'] === 'ready');
        const file = new PartFolders(data.dir).instanceFile(LOCAL_OWNER_ID, app.id);

        // Act
        const interacted = await services.browser.interact(app.id, revision, [{ action: 'fill', path: '$.screens.about.children.note', value: 'gift wrap' }]);
        const values = await eventually(() => inputValues(page), (found) => found.includes('gift wrap'));
        const stored = await eventually(
            () => readFile(file, 'utf8'),
            (text) => typeof text === 'string' && text.includes('gift wrap')
        );
        await page.close();

        // Assert
        expect(interacted.results.map((step) => step.ok)).toEqual([true]);
        expect(values).toContain('gift wrap');
        const instance = JSON.parse(stored) as { screens?: { about?: { children?: { note?: { value?: string } } } }; route?: unknown };
        expect(instance.screens?.about?.children?.note?.value).toBe('gift wrap');
        expect(instance.route).toEqual({ screen: 'about', params: {} });
    });
});
