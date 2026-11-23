import { afterEach, describe, expect, it } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { SharedChromium } from '../src/infrastructure/preview/SharedChromium.js';

const installed = await BrowserPreview.isInstalled();
const VIEWPORT = { width: 400, height: 300 } as const;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!installed)('SharedChromium (Chromium through Playwright)', () => {
    let shared: SharedChromium | undefined;
    afterEach(async () => {
        await shared?.close();
        shared = undefined;
    });

    it('should give each key a context of its own, prepared before its first page', async () => {
        // Arrange
        shared = new SharedChromium();
        const cookie = (value: string) => async (context: import('playwright').BrowserContext) => {
            await context.addCookies([{ name: 'who', value, domain: '127.0.0.1', path: '/' }]);
        };
        const ana = shared.source('ana', cookie('ana'));
        const ben = shared.source('ben', cookie('ben'));

        // Act
        const anaPage = await ana.newPage(VIEWPORT);
        const benPage = await ben.newPage(VIEWPORT);

        // Assert
        expect((await anaPage.context().cookies()).map((c) => c.value)).toEqual(['ana']);
        expect((await benPage.context().cookies()).map((c) => c.value)).toEqual(['ben']);
        expect(anaPage.context()).not.toBe(benPage.context());
        expect(anaPage.viewportSize()).toEqual(VIEWPORT);
        expect(shared.contexts).toBe(2);
    });

    it('should open one context when two pages of a key are asked for at once', async () => {
        // Arrange
        shared = new SharedChromium();
        const source = shared.source('ana');

        // Act
        const [first, second] = await Promise.all([source.newPage(VIEWPORT), source.newPage(VIEWPORT)]);

        // Assert
        expect(first.context()).toBe(second.context());
        expect(shared.contexts).toBe(1);
    });

    it('should close an idle context, and the browser with the last one', async () => {
        // Arrange
        shared = new SharedChromium({ idleMs: 150 });
        const source = shared.source('ana');
        const page = await source.newPage(VIEWPORT);

        // Act
        await wait(60);
        source.touch();
        await wait(110);
        const afterTouch = shared.contexts;
        await wait(250);

        // Assert
        expect(afterTouch).toBe(1);
        expect(page.isClosed()).toBe(true);
        expect(shared.contexts).toBe(0);
        expect(shared.running).toBe(false);
    });

    it('should close the context used longest ago to make room', async () => {
        // Arrange
        shared = new SharedChromium({ maxContexts: 2 });
        const ana = await shared.source('ana').newPage(VIEWPORT);
        await wait(5);
        const ben = await shared.source('ben').newPage(VIEWPORT);
        await wait(5);
        shared.source('ana').touch();

        // Act
        await shared.source('cy').newPage(VIEWPORT);

        // Assert
        expect(ben.isClosed()).toBe(true);
        expect(ana.isClosed()).toBe(false);
        expect(shared.contexts).toBe(2);
    });

    it('should close the oldest page of a context past its limit', async () => {
        // Arrange
        shared = new SharedChromium({ maxPagesPerContext: 2 });
        const source = shared.source('ana');
        const first = await source.newPage(VIEWPORT);
        const second = await source.newPage(VIEWPORT);

        // Act
        const third = await source.newPage(VIEWPORT);

        // Assert
        expect(first.isClosed()).toBe(true);
        expect(second.isClosed()).toBe(false);
        expect(third.isClosed()).toBe(false);
    });

    it('should keep the browser for other keys when one source closes', async () => {
        // Arrange
        shared = new SharedChromium();
        const ana = shared.source('ana');
        const anaPage = await ana.newPage(VIEWPORT);
        const benPage = await shared.source('ben').newPage(VIEWPORT);

        // Act
        await ana.close();

        // Assert
        expect(anaPage.isClosed()).toBe(true);
        expect(benPage.isClosed()).toBe(false);
        expect(shared.running).toBe(true);
    });
});
