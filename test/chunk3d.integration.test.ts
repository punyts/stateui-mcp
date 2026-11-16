import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { call, createApp, httpHarness, rootOf, tempData } from './helpers.js';
import type { HttpHarness, TempData, ToolResult } from './helpers.js';

const installed = await BrowserPreview.isInstalled();

const CHUNK_HASH = 'fedcba9876543210';
/**
 * A stand-in for the chunk of `@punyts/stateui-3d`: it sets the one global the real chunk sets. Its scenes paint a
 * 2D canvas in the host: red at first; a scene with a node `lose` then loses its "WebGL context" 100 ms after its
 * first frame (cleared, `webglcontextlost`) and gets it back 1.2 s later (green, `webglcontextrestored`), as the
 * first page of a newly started Chromium does (G3.1); a scene with a node `stuck` never says its frame is drawn
 */
const CHUNK_SCRIPT = `globalThis.__stateui3d = { version: 'fake-chunk', createScene3d: function (host) {
    var canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.append(canvas);
    var context = canvas.getContext('2d');
    var state = 'drawn';
    var scheduled = false;
    var stuck = false;
    var paint = function () {
        context.clearRect(0, 0, 40, 40);
        if (state === 'lost') return;
        context.fillStyle = state === 'restored' ? '#00ff00' : '#ff0000';
        context.fillRect(0, 0, 40, 40);
    };
    return {
        update: function (tree) {
            var keys = tree.map(function (node) { return node.key; });
            stuck = keys.indexOf('stuck') >= 0;
            paint();
            if (keys.indexOf('lose') >= 0 && !scheduled) {
                scheduled = true;
                setTimeout(function () {
                    state = 'lost';
                    paint();
                    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
                }, 100);
                setTimeout(function () {
                    state = 'restored';
                    paint();
                    canvas.dispatchEvent(new Event('webglcontextrestored'));
                }, 1300);
            }
        },
        drawn: function () {
            if (stuck) return new Promise(function () {});
            return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); });
        },
        hit: function () { return undefined; },
        boundsOf: function () { return undefined; },
        elementOf: function () { return undefined; },
        setReducedMotion: function () {},
        reducedMotion: false,
        dispose: function () { canvas.remove(); }
    };
} };
`;

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

    /** The colour at the centre of a screenshot, decoded in a page of the test's browser */
    async function centreOf(shot: ToolResult): Promise<[number, number, number]> {
        const page = await browser.newPage();
        try {
            return await page.evaluate(async (base64: string) => {
                const image = new Image();
                image.src = `data:image/png;base64,${base64}`;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d') as CanvasRenderingContext2D;
                context.drawImage(image, 0, 0);
                const [r = 0, g = 0, b = 0] = Array.from(context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data);
                return [r, g, b] as [number, number, number];
            }, shot.images[0]?.data ?? '');
        } finally {
            await page.close();
        }
    }

    /** A scene whose one node has this key, which the fake chunk acts on */
    const sceneWith = (key: string): Record<string, unknown> => ({
        component: 'scene3d',
        _title: 'Fake',
        children: { [key]: { component: 'mesh', geometry: { kind: 'box' }, material: { color: '#ff0000' } } }
    });

    it('should wait in ui_screenshot for a scene that loses its context after its first frame, and capture the frame after the restore (G3.10)', async () => {
        // Arrange
        await createApp(harness.client, 'loses-context', rootOf({ viewer: sceneWith('lose') }));

        // Act: the first frame is ready at once; the loss comes while the capture settles, the restore 1.2 s later
        const started = performance.now();
        const shot = await call(harness.client, 'ui_screenshot', { app: 'loses-context', path: '$.screens.home.children.viewer' });
        const took = performance.now() - started;

        // Assert
        expect(shot.isError).toBe(false);
        expect(shot.body['scenes']).toBeUndefined();
        expect(await centreOf(shot)).toEqual([0, 255, 0]);
        expect(took).toBeGreaterThan(1_000);
    });

    it('should return the capture with scenes: pending and the scene path when a scene never draws (G3.10)', { timeout: 40_000 }, async () => {
        // Arrange
        await createApp(harness.client, 'never-draws', rootOf({ viewer: sceneWith('stuck') }));

        // Act: the wait for the scene runs out after 10 s
        const shot = await call(harness.client, 'ui_screenshot', { app: 'never-draws' });

        // Assert
        expect(shot.isError).toBe(false);
        expect(shot.images).toHaveLength(1);
        expect(shot.body).toMatchObject({ target: 'page', scenes: 'pending', pending: ['$.screens.home.children.viewer'] });
    });
});
