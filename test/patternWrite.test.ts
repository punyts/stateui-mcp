import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PatternCatalog, PatternEntry } from '../src/application/ports/PatternCatalog.js';
import { WritePattern } from '../src/application/use-cases/WritePattern.js';
import { FilePartRepository } from '../src/infrastructure/storage/FilePartRepository.js';
import { KeyedLock } from '../src/infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../src/infrastructure/storage/PartFolders.js';
import { call, inMemoryHarness, silentReport, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

const STUB_SHELL = Object.freeze({ component: 'page', children: Object.freeze({ body: Object.freeze({ component: 'outlet' }) }) });
const ROOT = Object.freeze({
    component: 'panel',
    _title: 'Opening hours',
    children: Object.freeze({ hours: Object.freeze({ component: 'text', _text: 'Monday to Friday, 9 to 5' }) })
});
const SEARCH = Object.freeze({ summary: 'The opening hours of a shop', purposes: Object.freeze(['show opening hours', 'when the shop is open', 'business hours page']) });

let data: TempData;
let harness: InMemoryHarness;

async function patternNames(): Promise<string[]> {
    const listed = await call(harness.client, 'ui_list', { kind: 'patterns' });
    return (listed.body['items'] as { name: string }[]).map((part) => part.name);
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    const created = await call(harness.client, 'ui_app_create', { name: 'shop', shell: STUB_SHELL });
    if (created.isError) throw new Error(JSON.stringify(created.body));
    const written = await call(harness.client, 'ui_nodes_write', { app: 'shop', screen: 'home', expectedRevision: 1, operations: [{ op: 'set', path: 'root', value: ROOT }] });
    if (written.isError) throw new Error(JSON.stringify(written.body));
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_pattern_write', () => {
    it('should save a screen of an app as a pattern whose tree equals the screen, listed and read by the generic tools', async () => {
        // Act
        const written = await call(harness.client, 'ui_pattern_write', {
            name: 'opening-hours',
            kind: 'screen',
            ...SEARCH,
            from: { app: 'shop', screen: 'home' },
            slots: { more: { path: 'children', description: 'More about the hours' } },
            params: { title: { type: 'string', default: 'Opening hours', paths: ['_title'], description: 'The heading' } }
        });
        const read = await call(harness.client, 'ui_get', { kind: 'patterns', name: 'opening-hours' });

        // Assert
        expect(written.isError, JSON.stringify(written.body)).toBeFalsy();
        expect(written.body).toMatchObject({ name: 'opening-hours', revision: 1, created: true });
        expect(await patternNames()).toEqual(['opening-hours']);
        expect((read.body['value'] as { tree: unknown }).tree).toEqual(ROOT);
    });

    it('should save the shell of an app with screen "shell"', async () => {
        // Act
        const written = await call(harness.client, 'ui_pattern_write', { name: 'plain-frame', kind: 'shell', ...SEARCH, from: { app: 'shop', screen: 'shell' } });
        const read = await call(harness.client, 'ui_get', { kind: 'patterns', name: 'plain-frame' });

        // Assert
        expect(written.isError, JSON.stringify(written.body)).toBeFalsy();
        expect((read.body['value'] as { tree: unknown }).tree).toEqual(STUB_SHELL);
    });

    it('should refuse a slot path that is not in the tree, naming the path, and write nothing', async () => {
        // Act
        const written = await call(harness.client, 'ui_pattern_write', {
            name: 'opening-hours',
            kind: 'screen',
            ...SEARCH,
            from: { app: 'shop', screen: 'home' },
            slots: { more: { path: 'children.missing.children', description: 'Nowhere' } }
        });

        // Assert
        expect(written.body['error']).toBe('invalid-pattern');
        expect(JSON.stringify(written.body['errors'])).toContain('$.slots.more.path');
        expect(JSON.stringify(written.body['errors'])).toContain('patterns/opening-hours.pattern.json');
        expect(await patternNames()).toEqual([]);
    });

    it('should refuse a screen pattern that holds an outlet and a shell without one', async () => {
        // Act
        const screen = await call(harness.client, 'ui_pattern_write', { name: 'framed', kind: 'screen', ...SEARCH, tree: STUB_SHELL });
        const shell = await call(harness.client, 'ui_pattern_write', { name: 'frameless', kind: 'shell', ...SEARCH, tree: ROOT });

        // Assert
        expect(screen.body['error']).toBe('invalid-pattern');
        expect(shell.body['error']).toBe('invalid-pattern');
        expect(await patternNames()).toEqual([]);
    });

    it('should name the nearest screens when from names a screen the app does not have', async () => {
        // Act
        const written = await call(harness.client, 'ui_pattern_write', { name: 'opening-hours', kind: 'screen', ...SEARCH, from: { app: 'shop', screen: 'hom' } });

        // Assert
        expect(written.body).toMatchObject({ error: 'not-found', argument: 'from.screen' });
        expect(written.body['nearest']).toContain('home');
    });

    it('should keep what an update leaves out', async () => {
        // Arrange
        await call(harness.client, 'ui_pattern_write', { name: 'opening-hours', kind: 'screen', ...SEARCH, tree: ROOT });

        // Act
        const updated = await call(harness.client, 'ui_pattern_write', { name: 'opening-hours', expectedRevision: 1, summary: 'When the shop is open' });
        const read = await call(harness.client, 'ui_get', { kind: 'patterns', name: 'opening-hours' });

        // Assert
        expect(updated.body).toMatchObject({ revision: 2, created: false });
        expect(read.body['value']).toMatchObject({ kind: 'screen', summary: 'When the shop is open', tree: ROOT });
    });
});

describe('owner patterns in search and creation', () => {
    type Hit = { name: string; source: string; components: string[] };
    async function search(need: string): Promise<Hit[]> {
        const found = await call(harness.client, 'ui_patterns_search', { need });
        if (found.isError) throw new Error(JSON.stringify(found.body));
        return found.body['results'] as Hit[];
    }

    it('should find a screen saved with ui_pattern_write by its purposes and start a new screen from it', async () => {
        // Arrange
        await call(harness.client, 'ui_pattern_write', {
            name: 'opening-hours',
            kind: 'screen',
            ...SEARCH,
            from: { app: 'shop', screen: 'home' },
            params: { title: { type: 'string', default: 'Opening hours', paths: ['_title'], description: 'The heading' } }
        });

        // Act
        const results = await search('when the shop is open');
        const screen = await call(harness.client, 'ui_screen_create', { app: 'shop', name: 'hours', expectedRevision: 2, pattern: 'opening-hours', patternParams: { title: 'Hours' } });
        const read = await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' });

        // Assert
        expect(results[0]).toMatchObject({ name: 'opening-hours', source: 'owner' });
        expect(results[0]!.components).toEqual(['panel', 'text']);
        expect(results.filter((hit) => hit.name !== 'opening-hours').every((hit) => hit.source === 'library')).toBe(true);
        expect(screen.isError, JSON.stringify(screen.body)).toBeFalsy();
        const screens = (read.body['value'] as { screens: Record<string, { root: unknown }> }).screens;
        expect(screens['hours']!.root).toEqual({ ...ROOT, _title: 'Hours' });
    });

    it('should rank an owner pattern with the purposes of a library pattern beside it, each with its source', async () => {
        // Arrange
        const purposes = ['show key figures and a chart on one screen', 'overview of income and spending', 'finance dashboard with totals and a trend'];
        await call(harness.client, 'ui_pattern_write', { name: 'my-dashboard', kind: 'screen', summary: 'Our own figures screen', purposes, tree: ROOT });

        // Act
        const results = await search('finance dashboard with totals and a trend');

        // Assert
        const sources = new Map(results.map((hit) => [hit.name, hit.source]));
        expect(sources.get('dashboard')).toBe('library');
        expect(sources.get('my-dashboard')).toBe('owner');
        expect(results.slice(0, 2).map((hit) => hit.name).sort()).toEqual(['dashboard', 'my-dashboard']);
    });

    it('should no longer find an owner pattern deleted with ui_delete', async () => {
        // Arrange
        await call(harness.client, 'ui_pattern_write', { name: 'opening-hours', kind: 'screen', ...SEARCH, tree: ROOT });

        // Act
        const deleted = await call(harness.client, 'ui_delete', { kind: 'patterns', name: 'opening-hours', expectedRevision: 1 });
        const results = await search('when the shop is open');

        // Assert
        expect(deleted.isError, JSON.stringify(deleted.body)).toBeFalsy();
        expect(results.map((hit) => hit.name)).not.toContain('opening-hours');
    });

    it('should start an app from an owner shell', async () => {
        // Arrange
        await call(harness.client, 'ui_pattern_write', { name: 'plain-frame', kind: 'shell', ...SEARCH, from: { app: 'shop', screen: 'shell' } });

        // Act
        const created = await call(harness.client, 'ui_app_create', { name: 'kiosk', shell: { pattern: 'plain-frame' } });

        // Assert
        expect(created.isError, JSON.stringify(created.body)).toBeFalsy();
    });
});

describe('WritePattern and the library names', () => {
    it('should refuse the name of a library pattern, naming it, and write nothing', async () => {
        // Arrange
        const library: Pick<PatternCatalog, 'get'> = { get: (name) => (name === 'opening-hours' ? ({ name } as unknown as PatternEntry) : undefined) };
        const parts = new FilePartRepository(new PartFolders(data.dir), new KeyedLock(), { now: () => new Date(), newId: () => 'unused' });
        const writePattern = new WritePattern(parts, harness.services.useCases.writePart!, library, silentReport);

        // Act
        const result = await writePattern.execute({ name: 'opening-hours', kind: 'screen', ...SEARCH, tree: { ...ROOT } });

        // Assert
        expect(result).toMatchObject({ kind: 'invalid-name' });
        expect(result.kind === 'invalid-name' && result.reason).toContain('"opening-hours" is a library pattern');
        expect(await parts.findByName('patterns', 'opening-hours')).toBeUndefined();
    });
});
