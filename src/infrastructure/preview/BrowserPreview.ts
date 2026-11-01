import type { Browser, ElementHandle, Frame, Page } from 'playwright';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { KeyedLock } from '../storage/KeyedLock.js';
import type { PreviewHub, UiEvent } from './PreviewHub.js';

/** Chromium could not be started: not installed, or the sandbox refused. The message says what to run */
export class BrowserUnavailableError extends Error {
    constructor(reason: string) {
        super(
            `The headless browser could not be started (${reason}). Install Chromium once with "npx playwright install chromium" and try again.`
        );
        this.name = 'BrowserUnavailableError';
    }
}

/** A path that names no rendered element, or an action the element cannot take */
export class InteractionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InteractionError';
    }
}

export const INTERACT_ACTIONS = ['click', 'fill', 'press', 'hover', 'select'] as const;
export type InteractAction = (typeof INTERACT_ACTIONS)[number];

export interface InteractStep {
    readonly action: InteractAction;
    /** The state path of a node, such as `$.app.children.form.children.email` (the leading `$.` is optional) */
    readonly path: string;
    /** The text for `fill`, the key for `press` (`Enter`), the option value or label for `select` */
    readonly value?: string;
}

export interface InteractStepResult {
    readonly index: number;
    readonly action: InteractAction;
    readonly path: string;
    readonly ok: boolean;
    readonly error?: string;
}

export interface InteractResult {
    readonly results: readonly InteractStepResult[];
    readonly errors: readonly UiBuildError[];
    readonly events: readonly UiEvent[];
    readonly cursor: number;
}

export interface ScreenshotOptions {
    readonly path?: string;
    readonly width?: number;
    readonly height?: number;
    /** A `mode` overlay name from `ui_tokens_list`, such as `dark` */
    readonly mode?: string;
}

export interface ScreenshotResult {
    readonly png: Buffer;
    readonly width: number;
    readonly height: number;
    readonly target: string;
}

export interface PreviewOpenResult {
    readonly rendered: boolean;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const RENDER_TIMEOUT_MS = 10_000;
const SETTLE_MS = 300;

/** Where the controls of a component are: the first native control in its shadow root, else the element */
const CONTROL_SELECTORS: Readonly<Record<InteractAction, string>> = {
    click: 'button, [role="menuitem"], [role="button"], [role="tab"], a, input[type="checkbox"], input[type="radio"], summary',
    hover: 'button, [role="menuitem"], [role="button"], a',
    fill: 'input, textarea',
    press: 'input, textarea, select, button, [role="button"], [role="menuitem"], [tabindex]',
    select: 'select'
};

/** The element a root component renders: its `scope` knows the state path of its node. Declared for the type checker; the code runs in the page */
interface ScopedElement extends HTMLElement {
    scope?: { basePath?: string };
}

/** What the tools and the live views need of the headless browser. `BrowserPreview` is the Playwright implementation */
export type PreviewBrowser = Pick<BrowserPreview, 'open' | 'screenshot' | 'interact' | 'closePage' | 'close'>;

/**
 * One headless Chromium, started on first use and closed with the server, and one page per app that was asked
 * for. A page loads the same `/apps/:appId` URL a human opens, so what it renders and reports is what a person
 * sees. Tool calls on one app run one at a time
 */
export class BrowserPreview {
    private browser: Promise<Browser> | undefined;
    private readonly pages = new Map<string, Page>();
    private readonly lock = new KeyedLock();
    private closed = false;

    constructor(
        private readonly hub: PreviewHub,
        /** The origin the server listens on, such as `http://127.0.0.1:4100`. Read on each call, because the port may be chosen at listen time */
        private readonly baseUrl: () => string
    ) {}

    /** True when a Chromium build is installed for Playwright. It does not start one */
    static async isInstalled(): Promise<boolean> {
        try {
            const { chromium } = await import('playwright');
            const { existsSync } = await import('node:fs');
            return existsSync(chromium.executablePath());
        } catch {
            return false;
        }
    }

    /** Opens the headless page of the app, or reuses it, and waits until it has rendered `revision` */
    async open(appId: string, revision: number): Promise<PreviewOpenResult> {
        return this.lock.run(appId, async () => {
            await this.pageFor(appId);
            const rendered = await this.hub.waitRendered(appId, revision, 'headless', RENDER_TIMEOUT_MS);
            return { rendered };
        });
    }

    async screenshot(appId: string, revision: number, options: ScreenshotOptions): Promise<ScreenshotResult> {
        return this.lock.run(appId, async () => {
            const page = await this.pageFor(appId);
            await this.hub.waitRendered(appId, revision, 'headless', RENDER_TIMEOUT_MS);
            const viewport = { width: options.width ?? DEFAULT_VIEWPORT.width, height: options.height ?? DEFAULT_VIEWPORT.height };
            await page.setViewportSize(viewport);
            try {
                if (options.mode !== undefined) {
                    this.hub.publish(appId, { type: 'theme', kind: 'mode', name: options.mode }, 'headless');
                }
                await this.settle(page);
                if (options.path === undefined) {
                    const png = await page.screenshot({ type: 'png' });
                    return { png, ...viewport, target: 'page' };
                }
                const statePath = toStatePath(options.path);
                const handle = await this.elementAt(page, statePath);
                try {
                    const png = await handle.screenshot({ type: 'png' });
                    const box = await handle.boundingBox();
                    return { png, width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0), target: statePath };
                } finally {
                    await handle.dispose();
                }
            } finally {
                await page.setViewportSize(DEFAULT_VIEWPORT);
            }
        });
    }

    async interact(appId: string, revision: number, steps: readonly InteractStep[]): Promise<InteractResult> {
        return this.lock.run(appId, async () => {
            const page = await this.pageFor(appId);
            await this.hub.waitRendered(appId, revision, 'headless', RENDER_TIMEOUT_MS);
            const errorCursor = this.hub.errorCursor(appId);
            const eventCursor = this.hub.readEvents(appId, undefined).cursor;
            const results: InteractStepResult[] = [];
            for (const [index, step] of steps.entries()) {
                try {
                    await this.perform(page, step);
                    results.push({ index, action: step.action, path: step.path, ok: true });
                } catch (error) {
                    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
                    results.push({ index, action: step.action, path: step.path, ok: false, error: message });
                    break;
                }
            }
            await this.settle(page);
            const { events, cursor } = this.hub.readEvents(appId, eventCursor);
            return { results, errors: this.hub.errorsSince(appId, errorCursor), events, cursor };
        });
    }

    /** Closes the page of an app, such as after the app was deleted */
    async closePage(appId: string): Promise<void> {
        const page = this.pages.get(appId);
        this.pages.delete(appId);
        if (page !== undefined && !page.isClosed()) await page.close();
    }

    /** Closes every page and the browser. Safe to call twice and when nothing was started */
    async close(): Promise<void> {
        this.closed = true;
        const launching = this.browser;
        this.browser = undefined;
        this.pages.clear();
        if (launching === undefined) return;
        try {
            await (await launching).close();
        } catch {
            // the browser is already gone
        }
    }

    private async launch(): Promise<Browser> {
        if (this.closed) throw new BrowserUnavailableError('the server is shutting down');
        if (this.browser === undefined) {
            this.browser = (async () => {
                try {
                    const { chromium } = await import('playwright');
                    return await chromium.launch({ headless: true });
                } catch (error) {
                    this.browser = undefined;
                    throw new BrowserUnavailableError(error instanceof Error ? (error.message.split('\n')[0] ?? 'launch failed') : 'launch failed');
                }
            })();
        }
        return this.browser;
    }

    private async pageFor(appId: string): Promise<Page> {
        const existing = this.pages.get(appId);
        if (existing !== undefined && !existing.isClosed()) return existing;
        const browser = await this.launch();
        const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
        this.pages.set(appId, page);
        page.on('close', () => {
            if (this.pages.get(appId) === page) this.pages.delete(appId);
        });
        await page.goto(`${this.baseUrl()}/apps/${appId}`, { waitUntil: 'domcontentloaded' });
        return page;
    }

    private runtimeFrame(page: Page): Frame {
        const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
        if (frame === undefined) throw new InteractionError('The app has not been loaded into the page yet');
        return frame;
    }

    /** The element a root component rendered for the node at `statePath`, searching open shadow roots */
    private async elementAt(page: Page, statePath: string): Promise<ElementHandle<HTMLElement>> {
        const frame = this.runtimeFrame(page);
        const handle = await frame.evaluateHandle((wanted: string) => {
            const find = (root: ParentNode): HTMLElement | undefined => {
                for (const element of Array.from(root.querySelectorAll('*')) as ScopedElement[]) {
                    if (element.scope?.basePath === wanted && element.localName.startsWith('ui-')) return element;
                    if (element.shadowRoot) {
                        const inner = find(element.shadowRoot);
                        if (inner) return inner;
                    }
                }
                return undefined;
            };
            return find(document) ?? null;
        }, statePath);
        const element = handle.asElement() as ElementHandle<HTMLElement> | null;
        if (element === null) {
            await handle.dispose();
            throw new InteractionError(`Nothing is rendered at ${statePath}. Check the path with ui_outline; a hidden or closed node has no element`);
        }
        return element;
    }

    private async controlOf(element: ElementHandle<HTMLElement>, action: InteractAction): Promise<ElementHandle<HTMLElement>> {
        const found = await element.evaluateHandle((host: HTMLElement, selector: string) => {
            const own = host.shadowRoot?.querySelector<HTMLElement>(selector);
            if (own) return own;
            return host.matches(selector) ? host : (host.querySelector<HTMLElement>(selector) ?? null);
        }, CONTROL_SELECTORS[action]);
        const control = found.asElement() as ElementHandle<HTMLElement> | null;
        if (control === null) {
            await found.dispose();
            return element;
        }
        return control;
    }

    private async perform(page: Page, step: InteractStep): Promise<void> {
        const statePath = toStatePath(step.path);
        const element = await this.elementAt(page, statePath);
        const control = await this.controlOf(element, step.action);
        const timeout = 5000;
        try {
            switch (step.action) {
                case 'click':
                    await control.click({ timeout });
                    break;
                case 'hover':
                    await control.hover({ timeout });
                    break;
                case 'fill':
                    if (step.value === undefined) throw new InteractionError('fill needs a value');
                    await control.fill(step.value, { timeout });
                    // A user's change event fires on blur; fire it here so a field that listens for it sees the value
                    await control.evaluate((node: HTMLElement) => node.dispatchEvent(new Event('change', { bubbles: true, composed: true })));
                    break;
                case 'press':
                    if (step.value === undefined) throw new InteractionError('press needs a key, such as Enter');
                    await control.press(step.value, { timeout });
                    break;
                case 'select':
                    if (step.value === undefined) throw new InteractionError('select needs an option value or label');
                    await control.selectOption(step.value, { timeout });
                    break;
            }
        } finally {
            if (control !== element) await control.dispose();
            await element.dispose();
        }
    }

    private async settle(page: Page): Promise<void> {
        await page.waitForTimeout(SETTLE_MS);
    }
}

/** Accepts `$.app.children.x` and `app.children.x` */
export function toStatePath(path: string): string {
    return path.startsWith('$') ? path : `$.${path}`;
}

