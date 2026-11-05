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

export const INTERACT_ACTIONS = ['click', 'fill', 'press', 'hover', 'select', 'choose', 'focus', 'key', 'drag'] as const;

/** The actions that need no path: `key` presses on whatever has focus */
export const PATHLESS_ACTIONS: readonly InteractAction[] = ['key'];
export type InteractAction = (typeof INTERACT_ACTIONS)[number];

export interface InteractStep {
    readonly action: InteractAction;
    /** The state path of a node, such as `$.app.children.form.children.email` (the leading `$.` is optional); `key` takes none */
    readonly path?: string;
    /**
     * The text for `fill`, the key for `press` and `key` (`Enter`, `Space`), the option value or label for `select`
     * and `choose`, the state path of the drop target for `drag`
     */
    readonly value?: string;
}

export interface InteractStepResult {
    readonly index: number;
    readonly action: InteractAction;
    readonly path?: string;
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
    /** Grow the viewport to the height of the content, up to `MAX_FULL_PAGE_HEIGHT`; page captures only */
    readonly fullPage?: boolean;
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

/** A screen of an app with screens, and its params, that `open` shows instead of the one the instance is on */
export interface PreviewScreen {
    readonly screen: string;
    readonly params?: Readonly<Record<string, unknown>>;
}

/** The query of a view URL that opens a screen: `?screen=<name>&params=<json>` */
export function screenQuery(at: PreviewScreen | undefined): string {
    if (at === undefined) return '';
    const query = new URLSearchParams({ screen: at.screen });
    if (at.params !== undefined) query.set('params', JSON.stringify(at.params));
    return `?${query.toString()}`;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const RENDER_TIMEOUT_MS = 10_000;
const SETTLE_MS = 300;
/** A visible element is captured at once; this bounds the wait for one that never becomes stable */
const ELEMENT_SHOT_TIMEOUT_MS = 5_000;
/** The tallest viewport a full-page capture grows to, and how often it measures again while the content grows (a virtual list drawing more rows) */
export const MAX_FULL_PAGE_HEIGHT = 16_000;
const FULL_PAGE_PASSES = 3;

/** Where the controls of a component are: the first native control in its shadow root, else the element */
const CONTROL_SELECTORS: Readonly<Record<InteractAction, string>> = {
    click: 'button, [role="menuitem"], [role="button"], [role="tab"], a, input[type="checkbox"], input[type="radio"], summary',
    hover: 'button, [role="menuitem"], [role="button"], a',
    fill: 'input, textarea',
    press: 'input, textarea, select, button, [role="button"], [role="menuitem"], [tabindex]',
    select: 'select',
    choose: 'input[type="radio"], [role="radio"], .segment, select',
    focus: '',
    key: '',
    drag: ''
};

/** How often an action is tried again when its element was replaced while it ran (a tab switch re-rendering) */
const DETACHED_RETRIES = 3;
const DETACHED_WAIT_MS = 150;
const DETACHED = /not attached to the DOM|Element is detached|Execution context was destroyed|JSHandle is disposed/;

/** The element a root component renders: its `scope` knows the state path of its node. Declared for the type checker; the code runs in the page */
interface ScopedElement extends HTMLElement {
    scope?: { basePath?: string };
}

/** What the tools and the live views need of the headless browser. `BrowserPreview` is the Playwright implementation */
export type PreviewBrowser = Pick<BrowserPreview, 'open' | 'screenshot' | 'interact' | 'rendered' | 'closePage' | 'close'>;

/** A node the headless page draws: one per state path, in page order */
export interface RenderedNode {
    /** The state path of the node, such as `$.app.children.board.cols.k_open.body.main.slots.0` */
    readonly path: string;
    /** The component, from the element name: `ui-record-list` is `recordList` */
    readonly component: string;
    /** False when the node is drawn but has no box on screen (an inactive tab, a closed drawer) */
    readonly visible: boolean;
}

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

    /**
     * Opens the headless page of the app and waits until it has rendered `revision`. A page that is already open is
     * loaded again, so it shows the current document and state and not what it held since the last write. An app with
     * screens opens on the screen its instance is on (its `start` screen at first), or on `at` when given
     */
    async open(appId: string, revision: number, at?: PreviewScreen): Promise<PreviewOpenResult> {
        return this.lock.run(appId, async () => {
            const existing = this.pages.get(appId);
            if (existing !== undefined && !existing.isClosed()) {
                this.hub.markStale(appId, 'headless');
                if (at === undefined) await existing.reload({ waitUntil: 'domcontentloaded' });
                else await existing.goto(this.viewUrl(appId, at), { waitUntil: 'domcontentloaded' });
            } else {
                await this.pageFor(appId, at);
            }
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
                    if (options.fullPage === true) await this.growToContent(page, viewport);
                    const png = await page.screenshot({ type: 'png' });
                    return { png, ...viewport, target: 'page' };
                }
                const statePath = toStatePath(options.path);
                const handle = await this.boxOf(await this.elementAt(page, statePath));
                try {
                    //Playwright waits for an element to become visible, so a hidden one (such as the body of a closed
                    //modal) would hold the call until its timeout: refuse it at once instead
                    const box = await handle.boundingBox();
                    if (box === null || box.width === 0 || box.height === 0) {
                        throw new InteractionError(
                            `${statePath} is rendered but not visible (hidden, closed or zero size), so it has no image. Show it first, or take a screenshot of the page`
                        );
                    }
                    const png = await handle.screenshot({ type: 'png', timeout: ELEMENT_SHOT_TIMEOUT_MS }).catch((error: unknown) => {
                        if (error instanceof Error && error.name === 'TimeoutError') {
                            throw new InteractionError(`${statePath} did not settle for a screenshot within ${ELEMENT_SHOT_TIMEOUT_MS / 1000} s`);
                        }
                        throw error;
                    });
                    return { png, width: Math.round(box.width), height: Math.round(box.height), target: statePath };
                } finally {
                    await handle.dispose();
                }
            } finally {
                await page.setViewportSize(DEFAULT_VIEWPORT);
            }
        });
    }

    /**
     * The nodes the headless page draws at or below `under` (a state path), in page order: the nodes of the document
     * and the ones a component renders from a template (the rows of a list, the cards of a board), whose state paths
     * exist only while the app runs
     */
    async rendered(appId: string, revision: number, under: string): Promise<RenderedNode[]> {
        return this.lock.run(appId, async () => {
            const page = await this.pageFor(appId);
            await this.hub.waitRendered(appId, revision, 'headless', RENDER_TIMEOUT_MS);
            await this.settle(page);
            const frame = this.runtimeFrame(page);
            return frame.evaluate((root: string) => {
                const found: { path: string; component: string; visible: boolean }[] = [];
                const seen = new Set<string>();
                const hasBox = (element: Element): boolean => {
                    if (element.getClientRects().length > 0 && (element as HTMLElement).offsetParent !== null) return true;
                    // A host drawn with display: contents (a modal, a drawer) has its box in its shadow root
                    const shadow = (element as HTMLElement).shadowRoot;
                    return shadow !== null && Array.from(shadow.children).some((child) => child.getClientRects().length > 0 && (child as HTMLElement).offsetParent !== null);
                };
                const walk = (scope: ParentNode): void => {
                    for (const element of Array.from(scope.querySelectorAll('*')) as (HTMLElement & { scope?: { basePath?: string } })[]) {
                        const path = element.scope?.basePath;
                        if (element.localName.startsWith('ui-') && typeof path === 'string' && !seen.has(path) && (path === root || path.startsWith(`${root}.`))) {
                            seen.add(path);
                            const component = element.localName.slice(3).replace(/-([a-z])/g, (_match: string, letter: string) => letter.toUpperCase());
                            found.push({ path, component, visible: hasBox(element) });
                        }
                        if (element.shadowRoot) walk(element.shadowRoot);
                    }
                };
                walk(document);
                return found;
            }, under);
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
                const where = step.path === undefined ? {} : { path: step.path };
                try {
                    await this.performSettled(page, step);
                    results.push({ index, action: step.action, ...where, ok: true });
                } catch (error) {
                    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
                    results.push({ index, action: step.action, ...where, ok: false, error: message });
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

    private viewUrl(appId: string, at?: PreviewScreen): string {
        return `${this.baseUrl()}/apps/${appId}${screenQuery(at)}`;
    }

    private async pageFor(appId: string, at?: PreviewScreen): Promise<Page> {
        const existing = this.pages.get(appId);
        if (existing !== undefined && !existing.isClosed()) return existing;
        const browser = await this.launch();
        const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
        this.pages.set(appId, page);
        page.on('close', () => {
            if (this.pages.get(appId) === page) this.pages.delete(appId);
        });
        await page.goto(this.viewUrl(appId, at), { waitUntil: 'domcontentloaded' });
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

    /**
     * The element that draws a node: the host itself, or for a host with no box of its own (`display: contents`, such
     * as a modal or drawer, whose dialog is in its shadow root) the first element of its shadow root that has one
     */
    private async boxOf(element: ElementHandle<HTMLElement>): Promise<ElementHandle<HTMLElement>> {
        const found = await element.evaluateHandle((host: HTMLElement) => {
            if (host.getClientRects().length > 0 || host.shadowRoot === null) return null;
            return Array.from(host.shadowRoot.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.getClientRects().length > 0) ?? null;
        });
        const drawn = found.asElement() as ElementHandle<HTMLElement> | null;
        if (drawn === null) {
            await found.dispose();
            return element;
        }
        await element.dispose();
        return drawn;
    }

    /** True when an open modal dialog that does not hold `control` covers the page, so a press cannot reach it */
    private async behindModal(page: Page, control: ElementHandle<HTMLElement>): Promise<boolean> {
        const frame = this.runtimeFrame(page);
        const modals = await frame.evaluateHandle(() => {
            const found: HTMLDialogElement[] = [];
            const walk = (root: ParentNode): void => {
                for (const element of Array.from(root.querySelectorAll('*'))) {
                    if (element instanceof HTMLDialogElement && element.matches(':modal')) found.push(element);
                    if (element.shadowRoot) walk(element.shadowRoot);
                }
            };
            walk(document);
            return found;
        });
        try {
            return await control.evaluate((node: HTMLElement, open: HTMLDialogElement[]) => {
                if (open.length === 0) return false;
                const top = open[open.length - 1] as HTMLDialogElement;
                // The control is inside the dialog, or it is the host that draws the dialog in its shadow root
                for (let current: Node | null = node; current !== null; current = current.parentNode ?? (current as ShadowRoot).host ?? null) {
                    if (current === top) return false;
                }
                for (let current: Node | null = top; current !== null; current = current.parentNode ?? (current as ShadowRoot).host ?? null) {
                    if (current === node) return false;
                }
                return true;
            }, modals);
        } finally {
            await modals.dispose();
        }
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

    /** Runs an action, and runs it again when the element it found was replaced meanwhile (a re-render after a tab switch) */
    private async performSettled(page: Page, step: InteractStep): Promise<void> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                await this.perform(page, step);
                return;
            } catch (error) {
                if (attempt >= DETACHED_RETRIES || !(error instanceof Error) || !DETACHED.test(error.message)) throw error;
                await page.waitForTimeout(DETACHED_WAIT_MS);
            }
        }
    }

    /** The middle of the element that draws a node, in page coordinates */
    private async centerOf(page: Page, statePath: string, scroll = true): Promise<{ x: number; y: number }> {
        const handle = await this.boxOf(await this.elementAt(page, statePath));
        try {
            if (scroll) await handle.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
            const box = await handle.boundingBox();
            if (box === null || box.width === 0 || box.height === 0) throw new InteractionError(`${statePath} is rendered but not visible, so it cannot be dragged or dropped on`);
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        } finally {
            await handle.dispose();
        }
    }

    /**
     * Drags with the mouse from the middle of one node to the middle of another, in steps, as a user does. Both ends are
     * scrolled into view and measured before the button goes down: a board reads its column boxes when the drag starts, so
     * scrolling during the drag would drop on the wrong column
     */
    private async drag(page: Page, from: string, to: string): Promise<void> {
        await this.centerOf(page, to);
        await this.centerOf(page, from);
        const start = await this.centerOf(page, from, false);
        const end = await this.centerOf(page, to, false);
        const viewport = page.viewportSize();
        if (viewport !== null && (end.x < 0 || end.y < 0 || end.x > viewport.width || end.y > viewport.height)) {
            throw new InteractionError(`${from} and ${to} do not fit on the screen together, so one cannot be dragged onto the other; try a wider viewport or a nearer target`);
        }
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 });
        await page.mouse.move(end.x, end.y, { steps: 12 });
        await page.waitForTimeout(100);
        await page.mouse.up();
    }

    private async perform(page: Page, step: InteractStep): Promise<void> {
        if (step.action === 'key') {
            if (step.value === undefined) throw new InteractionError('key needs a key, such as Space or ArrowRight');
            // The key goes to whatever has focus: a focus action, or the control an earlier action left focused
            await page.keyboard.press(step.value);
            return;
        }
        if (step.path === undefined) throw new InteractionError(`${step.action} needs a path`);
        const statePath = toStatePath(step.path);
        if (step.action === 'drag') {
            if (step.value === undefined) throw new InteractionError('drag needs the state path of the drop target as value');
            await this.drag(page, statePath, toStatePath(step.value));
            return;
        }
        const element = await this.elementAt(page, statePath);
        if (step.action === 'focus') {
            try {
                if (await this.behindModal(page, element)) throw new InteractionError(behindModalMessage(statePath));
                // The control the node draws (the input of a searchBox), else the node's element or its nearest
                // focusable ancestor: a board card's slot, a list row
                const focused = await element.evaluate((host: HTMLElement) => {
                    const FOCUSABLE = 'input:not([type="hidden"]), textarea, select, button, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
                    const own = host.tabIndex >= 0 ? null : (host.shadowRoot ?? host).querySelector<HTMLElement>(FOCUSABLE);
                    if (own !== null) {
                        own.focus();
                        return true;
                    }
                    let current: HTMLElement | null = host;
                    while (current !== null && current.tabIndex < 0) {
                        current = current.parentElement ?? ((current.getRootNode() as ShadowRoot).host as HTMLElement | undefined) ?? null;
                    }
                    const target = current ?? host;
                    target.focus();
                    return target.matches(':focus') || target.getRootNode() !== document;
                });
                if (!focused) throw new InteractionError(`${statePath} and its ancestors take no focus`);
            } finally {
                await element.dispose();
            }
            return;
        }
        const control = await this.controlOf(element, step.action);
        const timeout = 5000;
        try {
            // A modal dialog covers the page: an action on anything outside it would do nothing, so say so
            if (await this.behindModal(page, control)) throw new InteractionError(behindModalMessage(statePath));
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
                case 'choose': {
                    if (step.value === undefined) throw new InteractionError('choose needs an option value or label');
                    // The option whose value or label is the value: a radio, a segment or an option of a native select
                    const option = await element.evaluateHandle((host: HTMLElement, wanted: string) => {
                        const root: ParentNode = host.shadowRoot ?? host;
                        const choices = Array.from(root.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"], .segment, select option'));
                        const valueOf = (choice: HTMLElement): string =>
                            choice.dataset['key'] ?? choice.dataset['value'] ?? (choice as HTMLInputElement | HTMLOptionElement).value ?? '';
                        const labelOf = (choice: HTMLElement): string =>
                            (choice.closest('label')?.textContent ?? choice.querySelector('.label')?.textContent ?? choice.getAttribute('aria-label') ?? choice.textContent ?? '').trim();
                        return choices.find((choice) => valueOf(choice) === wanted) ?? choices.find((choice) => labelOf(choice) === wanted.trim()) ?? null;
                    }, step.value);
                    const chosen = option.asElement() as ElementHandle<HTMLElement> | null;
                    if (chosen === null) {
                        await option.dispose();
                        throw new InteractionError(await this.noOptionMessage(element, statePath, step.value));
                    }
                    try {
                        const listed = await chosen.evaluate((node: HTMLElement) => node instanceof HTMLOptionElement);
                        if (listed) {
                            const select = (await chosen.evaluateHandle((node: HTMLElement) => node.closest('select'))).asElement() as ElementHandle<HTMLSelectElement> | null;
                            const value = await chosen.evaluate((node: HTMLElement) => (node as HTMLOptionElement).value);
                            await select?.selectOption(value, { timeout });
                            await select?.dispose();
                        } else {
                            await chosen.click({ timeout });
                        }
                    } finally {
                        await chosen.dispose();
                    }
                    break;
                }
            }
        } finally {
            if (control !== element) await control.dispose();
            await element.dispose();
        }
    }

    /** Says which options a choice component has, by value and by label, when none matched */
    private async noOptionMessage(element: ElementHandle<HTMLElement>, statePath: string, wanted: string): Promise<string> {
        const listed = await element.evaluate((host: HTMLElement) => {
            const root: ParentNode = host.shadowRoot ?? host;
            const choices = Array.from(root.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"], .segment, select option'));
            return choices.map((choice) => ({
                value: choice.dataset['key'] ?? choice.dataset['value'] ?? (choice as HTMLInputElement | HTMLOptionElement).value ?? '',
                label: (choice.closest('label')?.textContent ?? choice.querySelector('.label')?.textContent ?? choice.getAttribute('aria-label') ?? choice.textContent ?? '').trim()
            }));
        });
        if (listed.length === 0) return `${statePath} has no options to choose from`;
        const quote = (items: readonly string[]): string => items.map((item) => `"${item}"`).join(', ');
        return `${statePath} has no option "${wanted}". Values: ${quote(listed.map((item) => item.value))}. Labels: ${quote(listed.map((item) => item.label))}`;
    }

    /**
     * Grows the viewport (in place) to the height the app's content needs: the app may scroll its document or a
     * scrolling element of a component (the main area of a page), so the height is the viewport plus the most any of
     * them can still scroll. Measures again after each growth, since a taller view can draw more (virtual rows)
     */
    private async growToContent(page: Page, viewport: { width: number; height: number }): Promise<void> {
        for (let pass = 0; pass < FULL_PAGE_PASSES && viewport.height < MAX_FULL_PAGE_HEIGHT; pass += 1) {
            const extra = await this.runtimeFrame(page).evaluate(() => {
                let most = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
                const walk = (root: ParentNode): void => {
                    for (const element of Array.from(root.querySelectorAll('*'))) {
                        const overflow = getComputedStyle(element).overflowY;
                        if ((overflow === 'auto' || overflow === 'scroll') && element.clientHeight > 0) {
                            most = Math.max(most, element.scrollHeight - element.clientHeight);
                        }
                        if (element.shadowRoot) walk(element.shadowRoot);
                    }
                };
                walk(document);
                return Math.ceil(most);
            });
            if (extra <= 1) return;
            viewport.height = Math.min(MAX_FULL_PAGE_HEIGHT, viewport.height + extra);
            await page.setViewportSize(viewport);
            await this.settle(page);
        }
    }

    private async settle(page: Page): Promise<void> {
        await page.waitForTimeout(SETTLE_MS);
    }
}

function behindModalMessage(statePath: string): string {
    return `${statePath} is behind an open modal dialog: act inside the modal, or close it first`;
}

/** Accepts `$.app.children.x` and `app.children.x` */
export function toStatePath(path: string): string {
    return path.startsWith('$') ? path : `$.${path}`;
}

