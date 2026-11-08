import { describe, expect, it, vi } from 'vitest';
import type { PartKind } from '../../domain/partName.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../../testing/InMemoryUiPartRepository.js';
import { IndexedUiPartRepository } from '../IndexedUiPartRepository.js';
import type { UiAppValidator, UiPartError } from '../ports/UiAppValidator.js';
import { MAX_WARNED_APPS, WritePart } from './WritePart.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const BROKEN: UiBuildError = Object.freeze({ code: 'SUI-STATE-UNKNOWN', message: 'broken' });

/** Themes are valid unless their tokens hold `bad`; an app is broken while its theme's tokens hold `gone` */
const STORE = deepFreeze({ tokens: { color: { brand: '#204080' } } }) as UiPartBodies['themes'];
const BAD_THEME = deepFreeze({ tokens: { bad: true } }) as unknown as UiPartBodies['themes'];
const GONE_THEME = deepFreeze({ tokens: { gone: true } }) as unknown as UiPartBodies['themes'];

function appUsing(theme: string): UiPartBodies['apps'] {
    return deepFreeze({ uses: { themes: [theme] }, start: 'main', app: { component: 'app' }, screens: { main: { root: { component: 'text' } } } }) as UiPartBodies['apps'];
}

function fakeValidator(): UiAppValidator {
    return {
        resolveNode: () => undefined,
        localeOverlay: () => undefined,
        assembleApp: () => ({}),
        validateLocale: () => [],
        themeContrast: () => [],
        checkProperty: () => ({ kind: 'unknown-component' }),
        validatePart: (kind: PartKind, _name: string, body: unknown) => (kind === 'themes' && 'bad' in ((body as UiPartBodies['themes']).tokens ?? {}) ? [BROKEN] : []),
        validateAssembled: (_blueprint, parts, name): UiPartError[] => {
            const themes = Object.values(parts.themes ?? {});
            return themes.some((theme) => 'gone' in theme.tokens) ? [{ ...BROKEN, part: { kind: 'apps', name } }] : [];
        }
    };
}

async function setUp(apps: number): Promise<{ parts: IndexedUiPartRepository; writePart: WritePart; report: { info: ReturnType<typeof vi.fn> } }> {
    let next = 0;
    const parts = new IndexedUiPartRepository(new InMemoryUiPartRepository({ newId: () => `id-${++next}` }));
    await parts.create({ kind: 'themes', name: 'store', body: STORE });
    await parts.create({ kind: 'themes', name: 'plain', body: STORE });
    for (let n = 1; n <= apps; n++) await parts.create({ kind: 'apps', name: `app-${String(n).padStart(2, '0')}`, body: appUsing('store') });
    const report = Object.freeze({ info: vi.fn() });
    return { parts, writePart: new WritePart(parts, parts, fakeValidator(), report), report };
}

describe('WritePart', () => {
    it('should create a part on a first write, with no warnings', async () => {
        // Arrange
        const { parts, writePart } = await setUp(0);

        // Act
        const result = await writePart.execute({ kind: 'themes', name: 'dark', body: STORE });

        // Assert
        expect(result).toEqual({ kind: 'written', revision: 1, warnings: [], moreApps: 0, datasetWarnings: [] });
        expect((await parts.findByName('themes', 'dark'))?.revision).toBe(1);
    });

    it('should refuse a part with errors of its own and write nothing', async () => {
        // Arrange
        const { parts, writePart } = await setUp(1);

        // Act
        const result = await writePart.execute({ kind: 'themes', name: 'store', body: BAD_THEME, expectedRevision: 1 });

        // Assert
        expect(result).toEqual({ kind: 'invalid', errors: [BROKEN] });
        expect((await parts.findByName('themes', 'store'))?.body).toEqual(STORE);
    });

    it('should return a conflict with the current revision for a stale write and write nothing', async () => {
        // Arrange
        const { parts, writePart } = await setUp(0);
        await parts.write('themes', 'store', STORE, 1);

        // Act
        const result = await writePart.execute({ kind: 'themes', name: 'store', body: GONE_THEME, expectedRevision: 1 });

        // Assert
        expect(result).toEqual({ kind: 'conflict', currentRevision: 2 });
        expect((await parts.findByName('themes', 'store'))?.body).toEqual(STORE);
    });

    it('should return not-found for a write with a revision to a part that does not exist, and duplicate-name for a first write of a taken name', async () => {
        // Arrange
        const { writePart } = await setUp(0);

        // Act
        const missing = await writePart.execute({ kind: 'themes', name: 'nothing', body: STORE, expectedRevision: 1 });
        const taken = await writePart.execute({ kind: 'themes', name: 'store', body: STORE });

        // Assert
        expect([missing, taken]).toEqual([{ kind: 'not-found' }, { kind: 'duplicate-name' }]);
    });

    it('should write a change that breaks dependents and name at most 20 of them, counting the rest', async () => {
        // Arrange
        const { writePart, parts } = await setUp(25);
        await parts.create({ kind: 'apps', name: 'other', body: appUsing('plain') });

        // Act
        const result = await writePart.execute({ kind: 'themes', name: 'store', body: GONE_THEME, expectedRevision: 1 });

        // Assert
        if (result.kind !== 'written') throw new Error(result.kind);
        expect(result.revision).toBe(2);
        expect(result.warnings).toHaveLength(MAX_WARNED_APPS);
        expect(result.warnings[0]).toEqual({ app: 'app-01', errors: [{ ...BROKEN, part: { kind: 'apps', name: 'app-01' } }] });
        expect(result.warnings.map((warning) => warning.app)).not.toContain('other');
        expect(result.moreApps).toBe(5);
    });

    it('should report the outcome with names and counts only', async () => {
        // Arrange
        const { writePart, report } = await setUp(2);

        // Act
        await writePart.execute({ kind: 'themes', name: 'store', body: GONE_THEME, expectedRevision: 1 });

        // Assert
        expect(report.info).toHaveBeenLastCalledWith('Part write', { kind: 'themes', name: 'store', outcome: 'written', revision: 2, brokenApps: 2, brokenDatasets: 0 });
    });
});
