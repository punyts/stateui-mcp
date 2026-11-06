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
