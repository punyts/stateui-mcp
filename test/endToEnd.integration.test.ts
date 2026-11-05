import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPreview } from '../src/infrastructure/preview/BrowserPreview.js';
import { call, httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const installed = await BrowserPreview.isInstalled();

type Body = Record<string, unknown>;

/** Polls `read` until `check` passes or ten seconds are up, and returns the last value */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const value = await read().catch(() => undefined as T);
        if (check(value) || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/** The text a view page's runtime frame shows, through open shadow roots */
async function textOf(page: Page): Promise<string> {
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) return '';
    return frame.evaluate(() => {
        const walk = (root: ParentNode): string =>
            [...root.childNodes]
                .map((node) => {
                    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
                    if (!(node instanceof HTMLElement) || node.hidden) return '';
                    return (node.shadowRoot ? walk(node.shadowRoot) : '') + walk(node);
                })
                .join('');
        return walk(document.body);
    });
}

/**
 * The proof of owner-tree epic 3: an agent builds a multi-screen app from parts end to end through the registered
 * tools only (no use case is called), with the real validator and Chromium, and a second app reuses the theme and
 * the dataset without a copy of either
 */
describe.skipIf(!installed)('building a multi-screen app from parts through the tools (Chromium through Playwright)', () => {
    let data: TempData;
    let harness: HttpHarness;
    let browser: Browser;
    let shopId: string;

    /** Calls a tool and fails the build step on an error, with the tool's answer */
    async function step(tool: string, args: Body): Promise<Body> {
        const result = await call(harness.client, tool, args);
        if (result.isError) throw new Error(`${tool}: ${JSON.stringify(result.body)}`);
        return result.body;
    }

    /** The text of a fresh view of the shop once it shows `expected` */
    async function viewText(expected: string): Promise<string> {
        const page = await browser.newPage();
        try {
            await page.goto(`${harness.server.origin}/apps/${shopId}`);
            await page.waitForFunction(() => document.body.dataset['status'] === 'ready');
            return await eventually(() => textOf(page), (value) => typeof value === 'string' && value.includes(expected));
        } finally {
            await page.close();
        }
    }

    beforeAll(async () => {
        data = await tempData();
        harness = await httpHarness(data.dir);
        browser = await chromium.launch();

        // The parts the app uses: a theme, models, a seeded dataset and a logic module
        await step('ui_theme_write', { theme: 'harbor', operations: [{ op: 'set', path: 'color.accent.base', value: '#204080' }] });
        await step('ui_model_write', { model: 'product', operations: [{ op: 'set', field: 'name', type: 'string', required: true }] });
        await step('ui_model_write', {
            model: 'bag-line',
            operations: [
                { op: 'set', field: 'qty', type: 'integer', required: true },
                { op: 'set', field: 'lineTotal', type: 'number' }
            ]
        });
        await step('ui_model_write', { model: 'cart-totals', operations: [{ op: 'set', field: 'net', type: 'number', default: 0 }] });
        await step('ui_data_write', {
            dataset: 'catalog',
            model: 'product',
            operations: [
                { op: 'set', path: 'p1', value: { name: 'Harbor lamp' } },
                { op: 'set', path: 'p2', value: { name: 'Reading chair' } }
            ]
        });
        await step('ui_logic_write', {
            module: 'cart',
            needs: { bag: { model: 'bag-line' }, totals: { model: 'cart-totals' } },
            operations: [{ op: 'set', unit: 'rules.totals', value: { when: { path: '$.data.bag' }, do: [{ command: 'set', target: '$.data.totals.net', value: "{{ sum($.data.bag, 'lineTotal') }}" }] } }]
        });

        // The app, its second screen with a product param, and the nodes of its home screen with a navigate link
        const shop = await step('ui_app_create', {
            name: 'shop',
            title: 'Harbor shop',
            themes: ['harbor'],
            data: { products: { dataset: 'catalog' }, bag: { model: 'bag-line', scope: 'persona' }, totals: { model: 'cart-totals', scope: 'persona' } },
            logic: { cart: {} },
            shell: { component: 'page', _title: 'Harbor shop', children: { main: { component: 'outlet' } } }
        });
        shopId = shop['id'] as string;
        await step('ui_screen_create', {
            app: 'shop',
            name: 'product',
            expectedRevision: 1,
            title: 'Product',
            params: { product: { type: 'string', required: true } },
            root: { component: 'panel', _title: 'Product details' }
        });
        await step('ui_nodes_write', {
            app: 'shop',
            screen: 'home',
            expectedRevision: 2,
            operations: [
                { op: 'set', path: 'root._title', value: 'Our catalog' },
                { op: 'add', path: 'root', key: 'products', value: { component: 'list', '<-items': '$.data.products', row: { component: 'text', '<-_text': '$row.name' } } },
                { op: 'add', path: 'root', key: 'open', value: { component: 'button', _title: 'See the lamp', on: { press: { command: 'navigate', target: 'product', value: { product: 'p1' } } } } }
            ]
        });
    });

    afterAll(async () => {
        await browser?.close();
        await harness?.close();
        await data?.cleanup();
    });

    it('should validate the app with no errors', async () => {
        // Act
        const validated = await step('ui_validate', { app: 'shop' });

        // Assert
        expect(validated).toMatchObject({ app: 'shop', revision: 3, valid: true, errors: [] });
    });

    it('should show each screen\'s text in its screenshot, and open the product screen from the link', async () => {
        // Act
        const home = await call(harness.client, 'ui_screenshot', { app: 'shop', screen: 'home' });
        const homeText = await viewText('Reading chair');
        const product = await call(harness.client, 'ui_screenshot', { app: 'shop', screen: 'product', params: { product: 'p2' } });
        const productText = await viewText('Product details');
        await step('ui_preview', { app: 'shop', screen: 'home' });
        const clicked = await step('ui_interact', { app: 'shop', actions: [{ action: 'click', path: '$.screens.home.children.open' }] });
        const linkedText = await viewText('Product details');
        const state = await step('ui_state_get', { app: 'shop' });

        // Assert
        expect(home.images[0]?.mimeType).toBe('image/png');
        expect(homeText).toContain('Our catalog');
        expect(homeText).toContain('Harbor lamp');
        expect(homeText).toContain('Reading chair');
        expect(product.images[0]?.mimeType).toBe('image/png');
        expect(productText).toContain('Product details');
        expect(productText).not.toContain('Our catalog');
        expect((clicked['results'] as { ok: boolean }[]).map((result) => result.ok)).toEqual([true]);
        expect(linkedText).toContain('Product details');
        expect((state['state'] as { route: unknown }).route).toEqual({ screen: 'product', params: { product: 'p1' } });
    });

    it('should let a second app use the same theme and dataset with no copy of either', async () => {
        // Act
        await step('ui_app_create', {
            name: 'outlet-store',
            themes: ['harbor'],
            data: { products: { dataset: 'catalog' } },
            shell: { component: 'page', children: { main: { component: 'outlet' } } }
        });
        await step('ui_nodes_write', {
            app: 'outlet-store',
            screen: 'home',
            expectedRevision: 1,
            operations: [{ op: 'add', path: 'root', key: 'products', value: { component: 'list', '<-items': '$.data.products', row: { component: 'text', '<-_text': '$row.name' } } }]
        });
        const validated = await step('ui_validate', { app: 'outlet-store' });
        const tree = await step('ui_tree', { app: 'outlet-store', content: true });
        const themes = await step('ui_list', { kind: 'themes' });
        const datasets = await step('ui_list', { kind: 'data' });

        // Assert
        expect(validated).toMatchObject({ valid: true, errors: [] });
        expect(tree['text']).toContain('(2 records)');
        expect((themes['items'] as { name: string }[]).map((item) => item.name)).toEqual(['harbor']);
        expect((datasets['items'] as { name: string }[]).map((item) => item.name)).toEqual(['catalog']);
    });
});
