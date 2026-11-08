import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PatternCatalog, PatternEntry } from '../src/application/ports/PatternCatalog.js';
import { CreateScreen } from '../src/application/use-cases/CreateScreen.js';
import { createStateUiAdapters } from '../src/config/createStateUiAdapters.js';
import type { PartKind } from '../src/domain/partName.js';
import type { UiPartBodies } from '../src/domain/UiPart.js';
import { loadCatalogFile } from '../src/infrastructure/stateUiLibrary.js';
import { FilePartRepository } from '../src/infrastructure/storage/FilePartRepository.js';
import { KeyedLock } from '../src/infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../src/infrastructure/storage/PartFolders.js';
import { call, inMemoryHarness, silentReport, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

const CATALOG_PATTERNS = loadCatalogFile().patterns as readonly PatternEntry[];
const SCREENS = CATALOG_PATTERNS.filter((pattern) => pattern.kind === 'screen');

/** A model loose enough for the records every pattern's fixture datasets hold */
const ITEM = { fields: { title: { type: 'string' }, price: { type: 'number' }, description: { type: 'string' }, image: { type: 'string' } } } as unknown as UiPartBodies['models'];

let data: TempData;
let harness: InMemoryHarness;

async function write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K]): Promise<void> {
    const result = await harness.services.useCases.writePart!.execute({ kind, name, body });
    if (result.kind !== 'written') throw new Error(`${kind} ${name}: ${JSON.stringify(result)}`);
}

/**
 * The `$.data` names the path params of the patterns point at by default, each with the record keys the paths name:
 * `signIn` with `email` for `$.data.signIn.email`. `values` replaces the default of the params it names
 */
function dataNames(patterns: readonly PatternEntry[], values: Readonly<Record<string, string>> = {}): Record<string, string[]> {
    const names: Record<string, string[]> = {};
    for (const pattern of patterns) {
        for (const [paramName, param] of Object.entries(pattern.params)) {
            const path = values[paramName] ?? param.default;
            if (param.type !== 'path' || typeof path !== 'string') continue;
            const match = /^\$\.data\.([^.]+)(?:\.([^.]+))?/.exec(path);
            if (match === null) continue;
            const keys = (names[match[1] as string] ??= []);
            if (match[2] !== undefined && !keys.includes(match[2])) keys.push(match[2]);
        }
    }
    return names;
}

/**
 * Param values for the path params whose default names an array item (`$.data.products.0`): owner datasets key their
 * records by id and refuse integer-like keys, so an agent gives such a pattern the path of a record, here `r1`
 */
function recordPaths(pattern: PatternEntry): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [name, param] of Object.entries(pattern.params)) {
        if (param.type === 'path' && typeof param.default === 'string' && /\.\d+(\.|$)/.test(param.default)) {
            values[name] = param.default.replace(/\.\d+(?=\.|$)/g, '.r1');
        }
    }
    return values;
}

/** An owner dataset for each data name, bound under the same name and holding the records its paths name */
async function bindAll(names: Readonly<Record<string, readonly string[]>>): Promise<Record<string, { dataset: string }>> {
    await write('models', 'item', ITEM);
    const bindings: Record<string, { dataset: string }> = {};
    for (const [name, keys] of Object.entries(names)) {
        const dataset = `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-set`;
        const records = Object.fromEntries(['r1', ...keys].map((key) => [key, { title: 'One', price: 1, description: 'The first', image: '' }]));
        await write('data', dataset, { model: 'item', records } as unknown as UiPartBodies['data']);
        bindings[name] = { dataset };
    }
    return bindings;
}

async function revisionOf(app: string): Promise<number> {
    const read = await call(harness.client, 'ui_get', { kind: 'apps', name: app });
    return read.body['revision'] as number;
}

async function screenRoot(app: string, screen: string): Promise<unknown> {
    const read = await call(harness.client, 'ui_get', { kind: 'apps', name: app });
    return ((read.body['value'] as { screens: Record<string, { root: unknown }> }).screens[screen] as { root: unknown }).root;
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('creating from every pattern of the built catalog', () => {
    it('should have screen patterns to create from', () => {
        // Assert
        expect(SCREENS.length).toBeGreaterThan(0);
    });

    it.each(SCREENS.map((pattern) => [pattern.name]))('should create a screen from %s that validates with no errors', async (name) => {
        // Arrange
        const pattern = SCREENS.find((entry) => entry.name === name) as PatternEntry;
        const values = recordPaths(pattern);
        const created = await call(harness.client, 'ui_app_create', { name: 'shop', data: await bindAll(dataNames([pattern], values)) });
        expect(created.isError, JSON.stringify(created.body)).toBeFalsy();

        // Act
        const screen = await call(harness.client, 'ui_screen_create', {
            app: 'shop',
            name: 'start',
            expectedRevision: 1,
            pattern: name,
            ...(Object.keys(values).length > 0 && { patternParams: values })
        });
        const validated = await call(harness.client, 'ui_validate', { app: 'shop' });

        // Assert
        expect(screen.isError, JSON.stringify(screen.body)).toBeFalsy();
        expect(screen.body['slots']).toEqual(
            Object.entries(pattern.slots).map(([slot, { path, description }]) => ({ name: slot, path: `$.screens.start.${path}`, description }))
        );
        expect(validated.body['errors']).toEqual([]);
    });

    it.each(SCREENS.map((pattern) => [pattern.name]))('should create an app whose home screen is %s that validates with no errors', async (name) => {
        // Arrange
        const pattern = SCREENS.find((entry) => entry.name === name) as PatternEntry;
        const values = recordPaths(pattern);

        // Act
        const created = await call(harness.client, 'ui_app_create', {
            name: 'shop',
            data: await bindAll(dataNames([pattern], values)),
            home: { pattern: name, ...(Object.keys(values).length > 0 && { params: values }) }
        });
        const validated = await call(harness.client, 'ui_validate', { app: 'shop' });

        // Assert
        expect(created.isError, JSON.stringify(created.body)).toBeFalsy();
        expect(created.body['slots']).toEqual(
            Object.entries(pattern.slots).map(([slot, { path, description }]) => ({ name: slot, path: `$.screens.home.${path}`, description }))
        );
        expect(validated.body['errors']).toEqual([]);
    });
});

describe('pattern params and errors', () => {
    beforeEach(async () => {
        const created = await call(harness.client, 'ui_app_create', { name: 'shop', data: await bindAll({ products: [] }) });
        if (created.isError) throw new Error(JSON.stringify(created.body));
    });

    it('should write a given param value into the copied screen', async () => {
        // Act
        const screen = await call(harness.client, 'ui_screen_create', {
            app: 'shop',
            name: 'plants',
            expectedRevision: 1,
            pattern: 'product-grid',
            patternParams: { title: 'Our plants' }
        });

        // Assert
        expect(screen.isError).toBeFalsy();
        expect(await screenRoot('shop', 'plants')).toMatchObject({ _title: 'Our plants' });
    });

    it('should refuse an unknown param and a value of the wrong type, naming each param, and create nothing', async () => {
        // Act
        const result = await call(harness.client, 'ui_screen_create', {
            app: 'shop',
            name: 'plants',
            expectedRevision: 1,
            pattern: 'product-grid',
            patternParams: { title: 7, colour: 'green' }
        });

        // Assert
        expect(result.body).toMatchObject({ error: 'invalid-argument', argument: 'patternParams' });
        expect([...(result.body['params'] as string[])].sort()).toEqual(['colour', 'title']);
        expect(result.body['message']).toContain('"colour"');
        expect(await revisionOf('shop')).toBe(1);
    });

    it('should refuse a misspelt pattern with the nearest names', async () => {
        // Act
        const result = await call(harness.client, 'ui_screen_create', { app: 'shop', name: 'plants', expectedRevision: 1, pattern: 'product-gird' });

        // Assert
        expect(result.body).toMatchObject({ error: 'invalid-argument', argument: 'pattern' });
        expect(result.body['nearest']).toContain('product-grid');
    });

    it('should refuse a misspelt home pattern with the nearest names and create nothing', async () => {
        // Act
        const result = await call(harness.client, 'ui_app_create', { name: 'store', home: { pattern: 'product-gird' } });
        const listed = await call(harness.client, 'ui_list', { kind: 'apps' });

        // Assert
        expect(result.body).toMatchObject({ error: 'invalid-argument', argument: 'home' });
        expect(result.body['nearest']).toContain('product-grid');
        expect(JSON.stringify(listed.body)).not.toContain('"store"');
    });

    it('should refuse a screen whose path param names a dataset the app does not bind, naming the path and what to bind', async () => {
        // Act
        const screen = await call(harness.client, 'ui_screen_create', {
            app: 'shop',
            name: 'plants',
            expectedRevision: 1,
            pattern: 'product-grid',
            patternParams: { products: '$.data.plants' }
        });

        // Assert
        expect(screen.body['error']).toBe('invalid-app');
        expect(screen.body['errors']).toEqual([expect.objectContaining({ code: 'SUI-LINK-MISSING', statePath: '$.screens.plants.children.grid' })]);
        expect(JSON.stringify(screen.body['errors'])).toContain('$.data.plants');
        expect(screen.body['message']).toContain('bound in uses.data');
        expect(await revisionOf('shop')).toBe(1);
    });
});

describe('a copied pattern is ordinary nodes', () => {
    it('should leave the stored screen unchanged when the pattern changes after the write', async () => {
        // Arrange
        const parts = new FilePartRepository(new PartFolders(data.dir), new KeyedLock(), { now: () => new Date(), newId: randomUUID });
        const { validator } = createStateUiAdapters();
        let tree: object = { component: 'panel', _title: 'First' };
        const patterns: PatternCatalog = {
            get: (name) => (name === 'note' ? ({ name, kind: 'screen', summary: 'A note', purposes: ['note'], tree, slots: {}, params: {} } as unknown as PatternEntry) : undefined),
            names: () => ['note'],
            search: () => ({ results: [], weak: true }),
            preset: () => undefined,
            presets: () => [],
            withOwner: () => patterns
        };
        await parts.create({ kind: 'apps', name: 'notes', body: { start: 'home', app: { component: 'app' }, screens: { home: { root: { component: 'panel' } } } } as unknown as UiPartBodies['apps'] });
        const createScreen = new CreateScreen(parts, validator, patterns, silentReport);

        // Act
        const created = await createScreen.execute({ app: 'notes', name: 'note', expectedRevision: 1, root: { pattern: 'note' } });
        tree = { component: 'panel', _title: 'Second' };
        const stored = await parts.findByName('apps', 'notes');

        // Assert
        expect(created.kind).toBe('created');
        expect((stored?.body as unknown as { screens: Record<string, { root: unknown }> }).screens['note']?.root).toEqual({ component: 'panel', _title: 'First' });
    });
});
