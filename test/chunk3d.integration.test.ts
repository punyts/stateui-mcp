import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { createApp, httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const installed = await BrowserPreview.isInstalled();

const CHUNK_HASH = 'fedcba9876543210';
/** A stand-in for the chunk of `@punyts/stateui-3d`: it sets the one global the real chunk sets */
const CHUNK_SCRIPT = "globalThis.__stateui3d = { version: 'fake-chunk', createScene3d: function () { return {}; } };\n";

/**
 * The 3D chunk in a real page (G3.3): the server serves a fake chunk, so the host names it in `load.chunks`. An app
 * without a scene never asks for it; a `ui-load-3d` raised inside the frame loads it under the frame's policy. The
 * drawn scene is G3.5 and G3.10
 */
describe.skipIf(!installed)('the 3D chunk in the headless browser', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;

    beforeAll(async () => {
        data = await tempData();
        const chunkDir = join(data.dir, 'chunk');
        await mkdir(chunkDir);
        await writeFile(join(chunkDir, 'manifest.json'), JSON.stringify({ hash: CHUNK_HASH, script: `${CHUNK_HASH}.js` }));
        await writeFile(join(chunkDir, `${CHUNK_HASH}.js`), CHUNK_SCRIPT);
        harness = await httpHarness(join(data.dir, 'data'), undefined, { chunk3dDir: chunkDir });
        browser = await chromium.launch();
    });

    afterAll(async () => {
        await browser.close();
        await harness.close();
        await data.cleanup();
    });

    /** Opens the app's page and gives the paths of the requests made to `/runtime/` (the frame's page, stylesheet and scripts) */
    async function openCounting(page: Page, appId: string): Promise<string[]> {
        const runtime: string[] = [];
        page.on('request', (request) => {
            const path = new URL(request.url()).pathname;
            if (path.startsWith('/runtime/')) runtime.push(path);
        });
        await page.goto(`${harness.server.origin}/apps/${appId}`);
        await page.waitForSelector('body[data-status="ready"]');
        return runtime;
    }

    it('should request only the runtime page, its stylesheet and its script for an app with no scene', async () => {
        // Arrange
        const app = await createApp(harness.client, 'no-scene');
        const page = await browser.newPage();

        // Act
        const runtime = await openCounting(page, app.id);
        // Time for a late request, had anything asked for the chunk
        await page.waitForTimeout(500);
        const named = await page.getAttribute('body', 'data-chunk-3d');

        // Assert
        expect(named).toBe(CHUNK_HASH);
        expect(runtime).toHaveLength(3);
        expect(runtime.filter((path) => /^\/runtime\/[0-9a-f]{16}\.html$/.test(path))).toHaveLength(1);
        expect(runtime).toContain('/runtime/runtime.css');
        expect(runtime.filter((path) => /^\/runtime\/[0-9a-f]{16}\.js$/.test(path))).toHaveLength(1);
        expect(runtime).not.toContain(`/runtime/${CHUNK_HASH}.js`);
        await page.close();
    });

    it('should load the chunk once, under the frame policy, when ui-load-3d is raised in the frame', async () => {
        // Arrange
        const app = await createApp(harness.client, 'asks-for-3d');
        const page = await browser.newPage();
        const violations: string[] = [];
        page.on('console', (message) => {
            if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
        });
        const runtime = await openCounting(page, app.id);
        const frame = page.frames().find((candidate) => new URL(candidate.url()).pathname.startsWith('/runtime/'));
        if (frame === undefined) throw new Error('no runtime frame');

        // Act: raise the event twice, as two scenes would
        const answers = await frame.evaluate(async () => {
            const ask = () =>
                new Promise<string>((resolve) => {
                    let answered = false;
                    const detail = {
                        respond: (result: Promise<{ version: string }>) => {
                            answered = true;
                            result.then(
                                (chunk) => resolve(chunk.version),
                                (error: { code?: string }) => resolve(`failed: ${String(error.code)}`)
                            );
                        }
                    };
                    document.body.firstElementChild?.dispatchEvent(new CustomEvent('ui-load-3d', { detail, bubbles: true, composed: true }));
                    if (!answered) resolve('unanswered');
                });
            return Promise.all([ask(), ask()]);
        });

        // Assert
        expect(answers).toEqual(['fake-chunk', 'fake-chunk']);
        expect(runtime.filter((path) => path === `/runtime/${CHUNK_HASH}.js`)).toHaveLength(1);
        expect(violations).toEqual([]);
        await page.close();
    });
});
