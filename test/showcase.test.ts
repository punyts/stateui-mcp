import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildShowcase, CATEGORY_ORDER, EXCLUDED, PARTS_DIR, SHOWCASE_APP as BUILT_APP, loadCatalog } from '../scripts/buildShowcase.mjs';
import { holdsParts, installShowcase, SHOWCASE_APP } from '../src/config/showcase.js';
import { call, createApp, httpHarness, inMemoryHarness, noBrowser, silentReport, tempData } from './helpers.js';
import type { TempData } from './helpers.js';

interface Node {
    readonly component?: string;
    readonly [key: string]: unknown;
}

interface ShowcaseApp {
    readonly app: Node;
    readonly screens: Readonly<Record<string, { readonly title: string; readonly root: Node }>>;
}

/** Every file under a folder, by its path with forward slashes */
async function filesUnder(dir: string): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>();
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files.set(relative(dir, path).split(sep).join('/'), await readFile(path));
    }
    return files;
}

/** The text of a JSON file without carriage returns, so a checkout that turned line ends into CRLF still compares */
function comparable(path: string, content: Buffer | string): Buffer | string {
    return path.endsWith('.json') ? content.toString().replace(/\r\n/g, '\n') : Buffer.from(content);
}

/** The component name of every node in a tree, under any key */
function componentsIn(value: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) for (const item of value) componentsIn(item, found);
    else if (typeof value === 'object' && value !== null) {
        const node = value as Node;
        if (typeof node.component === 'string') found.add(node.component);
        for (const item of Object.values(node)) componentsIn(item, found);
    }
    return found;
}

/** The body of the built showcase app */
function builtApp(): ShowcaseApp {
    for (const [path, content] of buildShowcase()) {
        if (path.startsWith('apps/')) return (JSON.parse(content.toString()) as { body: ShowcaseApp }).body;
    }
    throw new Error('The showcase has no app');
}

/** The trees of the composed parts the showcase brings, by name */
function builtComposed(): Record<string, Node> {
    const trees: Record<string, Node> = {};
    for (const [path, content] of buildShowcase()) {
        if (!path.startsWith('components/')) continue;
        const part = JSON.parse(content.toString()) as { name: string; body: { tree: Node } };
        trees[part.name] = part.body.tree;
    }
    return trees;
}

/** The cards of a category screen: the children of its content panel */
function cardsOf(app: ShowcaseApp, category: string): Record<string, Node> | undefined {
    const content = (app.screens[category]?.root['children'] as Record<string, Node> | undefined)?.['content'];
    return content?.['children'] as Record<string, Node> | undefined;
}

describe('the showcase build', () => {
    it('should match the committed parts (run npm run showcase:build after changing the catalog or an example)', async () => {
        // Arrange
        const built = buildShowcase();

        // Act
        const committed = await filesUnder(PARTS_DIR);

        // Assert
        expect([...committed.keys()].sort()).toEqual([...built.keys()].sort());
        for (const [path, content] of built) expect(comparable(path, committed.get(path) ?? ''), path).toEqual(comparable(path, content));
    });

    it('should give every catalog component a card on the screen of its category, apart from the exclusions', () => {
        // Arrange
        const catalog = loadCatalog() as { components: { name: string; category: string; summary: string }[] };
        const app = builtApp();

        // Act
        const missing = catalog.components.filter((component) => !Object.hasOwn(EXCLUDED, component.name) && cardsOf(app, component.category) === undefined);
        const cards = catalog.components
            .filter((component) => !Object.hasOwn(EXCLUDED, component.name))
            .map((component) => [component, cardsOf(app, component.category)?.[component.name]] as const);

        // Assert
        expect(missing).toEqual([]);
        for (const [component, card] of cards) {
            expect(card, component.name).toMatchObject({ component: 'card', _title: component.name, _subtitle: component.summary });
        }
        for (const [name, reason] of Object.entries(EXCLUDED as Record<string, string>)) {
            expect(catalog.components.map((component) => component.name)).toContain(name);
            expect(reason.trim()).not.toBe('');
        }
    });

    it('should use every catalog component in the app, the exclusions aside', () => {
        // Arrange
        const catalog = loadCatalog() as { components: { name: string }[] };
        const app = builtApp();

        // Act
        const used = componentsIn([app.app, app.screens, builtComposed()]);

        // Assert
        expect(catalog.components.map((component) => component.name).filter((name) => !used.has(name) && !Object.hasOwn(EXCLUDED, name))).toEqual([]);
    });

    it('should have a home screen and a screen per category, each with a menu item', () => {
        // Act
        const app = builtApp();
        const menu = builtComposed()['showcaseMenu'] as { children: object } & Node;

        // Assert
        expect(Object.keys(app.screens)).toEqual(['home', ...CATEGORY_ORDER]);
        expect(Object.keys(menu.children)).toEqual(['home', ...CATEGORY_ORDER]);
        expect(BUILT_APP).toBe(SHOWCASE_APP);
    });

    it('should place the shared header and menu in every screen, and keep the toasts on the app node', () => {
        // Act
        const app = builtApp();

        // Assert
        expect(app.app).toMatchObject({ component: 'app', _title: 'Component showcase', toasts: { component: 'toastRegion' } });
        for (const [name, screen] of Object.entries(app.screens)) {
            expect(screen.root['children'], name).toMatchObject({
                header: { component: 'showcaseHeader', placement: { region: 'n' } },
                menu: { component: 'showcaseMenu', placement: { region: 'w' } },
                content: { component: 'panel', placement: { region: 'center' } }
            });
        }
    });
});

describe('installing the showcase', () => {
    let data: TempData;

    beforeEach(async () => {
        data = await tempData();
    });

    afterEach(async () => {
        await data.cleanup();
    });

    it('should install the parts and names.json on an empty data directory, and validate with no errors', async () => {
        // Act
        const installed = await installShowcase({ dataDir: data.dir, report: silentReport });
        const harness = await inMemoryHarness(data.dir);
        try {
            const listed = await call(harness.client, 'ui_list', { kind: 'apps' });
            const validated = await call(harness.client, 'ui_validate', { app: SHOWCASE_APP });
            const names = JSON.parse(await readFile(join(data.dir, 'names.json'), 'utf8')) as Record<string, Record<string, string>>;

            // Assert
            expect(installed).toBe(true);
            expect(JSON.stringify(listed.body)).toContain(SHOWCASE_APP);
            expect(Object.keys(names['apps'] ?? {})).toEqual([SHOWCASE_APP]);
            expect(Object.keys(names['themes'] ?? {})).toHaveLength(4);
            expect(validated.isError).toBe(false);
            expect(validated.body['errors']).toEqual([]);
            expect(validated.body['valid']).toBe(true);
        } finally {
            await harness.close();
        }
    });

    it('should install on a data directory that does not exist yet', async () => {
        // Act
        const installed = await installShowcase({ dataDir: join(data.dir, 'new'), report: silentReport });

        // Assert
        expect(installed).toBe(true);
        expect(await holdsParts(join(data.dir, 'new'))).toBe(true);
    });

    it('should log one line when it installs', async () => {
        // Arrange
        const lines: string[] = [];

        // Act
        await installShowcase({ dataDir: data.dir, report: { info: (message: string) => lines.push(message) } });

        // Assert
        expect(lines).toEqual(['Installed the component showcase on the new data directory']);
    });

    it('should leave a data directory that holds a part alone, and never install twice', async () => {
        // Arrange
        const harness = await inMemoryHarness(data.dir);
        await createApp(harness.client, 'mine');
        await harness.close();

        // Act
        const installed = await installShowcase({ dataDir: data.dir, report: silentReport });
        const again = await inMemoryHarness(data.dir);
        const listed = await call(again.client, 'ui_list', { kind: 'apps' });
        await again.close();

        // Assert
        expect(installed).toBe(false);
        expect(JSON.stringify(listed.body)).toContain('"mine"');
        expect(JSON.stringify(listed.body)).not.toContain(SHOWCASE_APP);
    });

    it('should not install again once the showcase is there, or after it was deleted while other parts remain', async () => {
        // Arrange
        await installShowcase({ dataDir: data.dir, report: silentReport });
        const before = await filesUnder(data.dir);

        // Act
        const second = await installShowcase({ dataDir: data.dir, report: silentReport });

        // Assert
        expect(second).toBe(false);
        expect([...(await filesUnder(data.dir)).keys()].sort()).toEqual([...before.keys()].sort());
    });

    it('should count an app of the old store as a part', async () => {
        // Arrange
        const appId = '11111111-2222-4333-8444-555555555555';
        await mkdir(join(data.dir, appId), { recursive: true });
        await writeFile(join(data.dir, appId, 'app.json'), '{}');

        // Act
        const installed = await installShowcase({ dataDir: data.dir, report: silentReport });

        // Assert
        expect(installed).toBe(false);
    });

    it('should install when the server starts on an empty data directory with showcase on, and not with it off', async () => {
        // Arrange
        const other = await tempData();

        // Act
        const on = await httpHarness(data.dir, noBrowser, { showcase: true });
        const off = await httpHarness(other.dir, noBrowser, { showcase: false });
        const listedOn = await call(on.client, 'ui_list', { kind: 'apps' });
        const listedOff = await call(off.client, 'ui_list', { kind: 'apps' });
        await on.close();
        await off.close();
        await other.cleanup();

        // Assert
        expect(JSON.stringify(listedOn.body)).toContain(SHOWCASE_APP);
        expect(JSON.stringify(listedOff.body)).not.toContain(SHOWCASE_APP);
    });
});
