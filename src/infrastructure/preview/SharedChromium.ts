import type { Browser, BrowserContext, Page } from 'playwright';
import { report } from '@punyts/core';
import { msSince } from '../msSince.js';
import { BrowserUnavailableError } from './BrowserPreview.js';

const CATEGORY = 'preview';

/** The size of a new page */
export interface Viewport {
    readonly width: number;
    readonly height: number;
}

/** Where a `BrowserPreview` gets its pages, such as one context of a `SharedChromium` */
export interface PageSource {
    /** A new page of the given size */
    newPage(viewport: Viewport): Promise<Page>;
    /** Marks the source as in use, so it is not closed as idle */
    touch(): void;
    /** Closes what the source holds; the browser behind it may stay open for other sources */
    close(): Promise<void>;
}

export interface SharedChromiumOptions {
    /** A context closes after this long without a page opened or a `touch`; default 10 minutes */
    readonly idleMs?: number;
    /** At most this many contexts are open; opening one more closes the one used longest ago. Default 4 */
    readonly maxContexts?: number;
    /** At most this many pages are open in a context; opening one more closes its oldest. Default 3 */
    readonly maxPagesPerContext?: number;
    /** Extra Chromium arguments */
    readonly launchArgs?: readonly string[];
}

/** A context's setup before its first page, such as the cookies it signs in with */
export type PrepareContext = (context: BrowserContext) => Promise<void>;

interface Held {
    readonly context: Promise<BrowserContext>;
    readonly pages: Page[];
    used: number;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * One headless Chromium shared by many sources, each a browser context of its own (its own cookies and storage),
 * keyed by the caller, such as a workspace. Chromium starts with the first page and closes with the last context, a
 * context closes after `idleMs` without use, and the counts of contexts and of pages per context are capped, so a
 * server that is not checking anything holds no browser
 */
export class SharedChromium {
    private browser: Promise<Browser> | undefined;
    private readonly held = new Map<string, Held>();
    private readonly opening = new Map<string, Promise<Held>>();
    private closed = false;
    private readonly idleMs: number;
    private readonly maxContexts: number;
    private readonly maxPages: number;

    constructor(private readonly options: SharedChromiumOptions = {}) {
        this.idleMs = options.idleMs ?? 10 * 60 * 1000;
        this.maxContexts = options.maxContexts ?? 4;
        this.maxPages = options.maxPagesPerContext ?? 3;
    }

    /** The page source of `key`; `prepare` runs on each new context of it, before its first page */
    source(key: string, prepare: PrepareContext = async () => {}): PageSource {
        return {
            newPage: (viewport) => this.newPage(key, prepare, viewport),
            touch: () => this.touch(key),
            close: () => this.closeContext(key)
        };
    }

    /** The number of open contexts */
    get contexts(): number {
        return this.held.size;
    }

    /** Whether Chromium is running */
    get running(): boolean {
        return this.browser !== undefined;
    }

    /** Closes every context and the browser. Safe to call twice */
    async close(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.held.keys()].map((key) => this.closeContext(key)));
        await this.closeBrowser();
    }

    private async newPage(key: string, prepare: PrepareContext, viewport: Viewport): Promise<Page> {
        const held = await this.contextOf(key, prepare);
        const context = await held.context;
        const page = await context.newPage();
        await page.setViewportSize(viewport);
        held.pages.push(page);
        page.on('close', () => {
            const index = held.pages.indexOf(page);
            if (index >= 0) held.pages.splice(index, 1);
        });
        while (held.pages.length > this.maxPages) await held.pages[0]?.close();
        this.touch(key);
        return page;
    }

    private contextOf(key: string, prepare: PrepareContext): Promise<Held> {
        const existing = this.held.get(key);
        if (existing !== undefined) return Promise.resolve(existing);
        let opening = this.opening.get(key);
        if (opening === undefined) {
            opening = this.openContext(key, prepare).finally(() => this.opening.delete(key));
            this.opening.set(key, opening);
        }
        return opening;
    }

    private async openContext(key: string, prepare: PrepareContext): Promise<Held> {
        if (this.closed) throw new BrowserUnavailableError('the server is shutting down');
        while (this.held.size >= this.maxContexts) {
            const oldest = [...this.held.entries()].sort((a, b) => a[1].used - b[1].used)[0];
            if (oldest === undefined) break;
            report(CATEGORY, 'Browser context closed to make room', {});
            await this.closeContext(oldest[0]);
        }
        const context = (async () => {
            const browser = await this.launch();
            const made = await browser.newContext();
            await prepare(made);
            return made;
        })();
        const held: Held = { context, pages: [], used: Date.now() };
        this.held.set(key, held);
        try {
            await context;
        } catch (error) {
            if (this.held.get(key) === held) this.held.delete(key);
            await this.closeIfUnused();
            throw error;
        }
        return held;
    }

    private touch(key: string): void {
        const held = this.held.get(key);
        if (held === undefined) return;
        held.used = Date.now();
        if (held.timer !== undefined) clearTimeout(held.timer);
        held.timer = setTimeout(() => {
            report(CATEGORY, 'Idle browser context closed', {});
            void this.closeContext(key);
        }, this.idleMs);
        held.timer.unref?.();
    }

    private async closeContext(key: string): Promise<void> {
        const held = this.held.get(key);
        if (held === undefined) return;
        this.held.delete(key);
        if (held.timer !== undefined) clearTimeout(held.timer);
        try {
            await (await held.context).close();
        } catch {
            // the context never opened, or the browser is already gone
        }
        await this.closeIfUnused();
    }

    private async closeIfUnused(): Promise<void> {
        if (this.held.size === 0) await this.closeBrowser();
    }

    private async closeBrowser(): Promise<void> {
        const launching = this.browser;
        this.browser = undefined;
        if (launching === undefined) return;
        try {
            await (await launching).close();
            report(CATEGORY, 'Shared headless browser closed', {});
        } catch {
            // it never started, or it is already gone
        }
    }

    private async launch(): Promise<Browser> {
        if (this.browser === undefined) {
            this.browser = (async () => {
                const start = performance.now();
                try {
                    const { chromium } = await import('playwright');
                    const args = this.options.launchArgs ?? [];
                    const browser = await chromium.launch({ headless: true, ...(args.length > 0 && { args: [...args] }) });
                    report(CATEGORY, 'Shared headless browser started', { ms: msSince(start) });
                    return browser;
                } catch (error) {
                    this.browser = undefined;
                    throw new BrowserUnavailableError(error instanceof Error ? (error.message.split('\n')[0] ?? 'launch failed') : 'launch failed');
                }
            })();
        }
        return this.browser;
    }
}
