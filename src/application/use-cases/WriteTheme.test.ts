import { describe, expect, it, vi } from 'vitest';
import type { PartKind } from '../../domain/partName.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../../testing/InMemoryUiPartRepository.js';
import { IndexedUiPartRepository } from '../IndexedUiPartRepository.js';
import type { ComponentCatalog } from '../ports/ComponentCatalog.js';
import type { PatternCatalog } from '../ports/PatternCatalog.js';
import type { UiAppValidator, UiPartError } from '../ports/UiAppValidator.js';
import { CreateTheme, WriteTheme } from './WriteTheme.js';
import { WritePart } from './WritePart.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const STORE = deepFreeze({ tokens: { button: { fill: '#204080' } }, overlays: { night: { kind: 'mode', tokens: { color: { surface: { base: '#101010' } } } } } }) as unknown as UiPartBodies['themes'];
const APP = deepFreeze({ uses: { themes: ['store'] }, start: 'main', shell: { component: 'outlet' }, screens: { main: { root: { component: 'button' } } } }) as unknown as UiPartBodies['apps'];
const PRESET = deepFreeze({ name: 'calm', tokens: { color: { accent: { base: '#305070' } } } });

/** An app is broken while its theme has no `button.fill`, standing in for a component token the app relies on */
function fakeValidator(): UiAppValidator {
    return {
        resolveNode: () => undefined,
        localeOverlay: () => undefined,
        assembleApp: () => ({}),
        validateLocale: () => [],
        themeContrast: () => [{ mode: 'light', text: 'color.text.base', surface: 'color.surface.base', ratio: 21, passesAA: true }],
        checkProperty: () => ({ kind: 'unknown-component' }),
        validatePart: (_kind: PartKind) => [],
        validateAssembled: (_blueprint, parts, name): UiPartError[] => {
            const theme = parts.themes?.['store'] as { tokens: { button?: { fill?: string } } } | undefined;
            return theme?.tokens.button?.fill === undefined ? [{ code: 'SUI-THEME-TOKEN', message: 'button.fill is gone', part: { kind: 'apps', name } }] : [];
        }
    };
}

const CATALOG = {
    list: () => [{ name: 'button' }],
    get: () => ({ name: 'button', tokens: [{ path: 'button.fill', type: 'color', default: '{color.accent.base}' }] }),
    listTokens: () => []
} as unknown as ComponentCatalog;

const PATTERNS: PatternCatalog = { get: () => undefined, names: () => [], search: () => ({ results: [], weak: true }), preset: (name) => (name === 'calm' ? (PRESET as never) : undefined) };

async function setUp() {
    let next = 0;
    const parts = new IndexedUiPartRepository(new InMemoryUiPartRepository({ newId: () => `id-${++next}` }));
    await parts.create({ kind: 'themes', name: 'store', body: STORE });
    await parts.create({ kind: 'apps', name: 'shop', body: APP });
    const report = Object.freeze({ info: vi.fn() });
    const validator = fakeValidator();
    const writePart = new WritePart(parts, parts, validator, report);
    return {
        parts,
        writeTheme: new WriteTheme(parts, writePart, validator, CATALOG, report),
        createTheme: new CreateTheme(parts, writePart, validator, PATTERNS, report)
    };
}

describe('WriteTheme', () => {
    it('should warn and name the app when a token it uses is removed, and still write', async () => {
        // Arrange
        const { parts, writeTheme } = await setUp();

        // Act
        const result = await writeTheme.execute({ theme: 'store', expectedRevision: 1, operations: [{ op: 'remove', path: 'button.fill' }] });

        // Assert
        expect(result).toMatchObject({
            kind: 'written',
            revision: 2,
            warnings: [{ app: 'shop', errors: [{ code: 'SUI-THEME-TOKEN' }] }],
            reaches: [{ token: 'button.fill', components: ['button'] }],
            contrast: [{ mode: 'light', ratio: 21 }]
        });
        expect((await parts.findByName('themes', 'store'))?.body.tokens).toEqual({});
    });

    it('should add an overlay, set a token in it and remove another overlay in one write', async () => {
        // Arrange
        const { parts, writeTheme } = await setUp();

        // Act
        const result = await writeTheme.execute({
            theme: 'store',
            expectedRevision: 1,
            operations: [
                { op: 'add-overlay', overlay: 'acme', kind: 'brand' },
                { op: 'set', overlay: 'acme', path: 'radius.md', value: '2px' },
                { op: 'remove-overlay', overlay: 'night' }
            ]
        });

        // Assert
        expect(result).toMatchObject({ kind: 'written', warnings: [] });
        expect((await parts.findByName('themes', 'store'))?.body.overlays).toEqual({ acme: { kind: 'brand', tokens: { radius: { md: '2px' } } } });
    });

    it('should refuse an operation on a missing overlay or token, a duplicate overlay and a stale revision', async () => {
        // Arrange
        const { writeTheme } = await setUp();

        // Act
        const overlay = await writeTheme.execute({ theme: 'store', expectedRevision: 1, operations: [{ op: 'set', overlay: 'nigt', path: 'color.text.base', value: '#000' }] });
        const token = await writeTheme.execute({ theme: 'store', expectedRevision: 1, operations: [{ op: 'remove', path: 'color.text.base' }] });
        const duplicate = await writeTheme.execute({ theme: 'store', expectedRevision: 1, operations: [{ op: 'add-overlay', overlay: 'night', kind: 'mode' }] });
        const stale = await writeTheme.execute({ theme: 'store', expectedRevision: 2, operations: [{ op: 'remove', path: 'button.fill' }] });
        const missing = await writeTheme.execute({ theme: 'stor', expectedRevision: 1, operations: [{ op: 'remove', path: 'button.fill' }] });

        // Assert
        expect(overlay).toMatchObject({ kind: 'invalid-operation', index: 0, error: { message: expect.stringContaining('nearest: night') } });
        expect(token).toMatchObject({ kind: 'invalid-operation', index: 0 });
        expect(duplicate).toMatchObject({ kind: 'invalid-operation', index: 0 });
        expect(stale).toEqual({ kind: 'conflict', currentRevision: 1 });
        expect(missing).toEqual({ kind: 'not-found', nearest: ['store'] });
    });
});

describe('CreateTheme', () => {
    it('should copy a theme or a preset into a new theme at revision 1', async () => {
        // Arrange
        const { parts, createTheme } = await setUp();

        // Act
        const copy = await createTheme.execute({ name: 'store-copy', from: 'store' });
        const preset = await createTheme.execute({ name: 'calm-shop', preset: 'calm' });

        // Assert
        expect(copy).toMatchObject({ kind: 'created', revision: 1 });
        expect(preset).toMatchObject({ kind: 'created', revision: 1 });
        expect((await parts.findByName('themes', 'calm-shop'))?.body).toEqual({ tokens: { color: { accent: { base: '#305070' } } } });
    });

    it('should refuse a bad name, a missing source, an unknown preset and a taken name', async () => {
        // Arrange
        const { createTheme } = await setUp();

        // Act / Assert
        expect(await createTheme.execute({ name: 'Store Two', from: 'store' })).toMatchObject({ kind: 'invalid-name' });
        expect(await createTheme.execute({ name: 'two', from: 'stor' })).toEqual({ kind: 'not-found', nearest: ['store'] });
        expect(await createTheme.execute({ name: 'two', preset: 'loud' })).toEqual({ kind: 'unknown-preset', preset: 'loud' });
        expect(await createTheme.execute({ name: 'store', from: 'store' })).toEqual({ kind: 'duplicate-name' });
    });
});
