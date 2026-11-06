import { describe, expect, it } from 'vitest';
import { InvalidSearchArgumentError } from '../application/ports/ComponentCatalog.js';
import type { PatternEntry } from '../application/ports/PatternCatalog.js';
import { StateUiPatternCatalog } from './StateUiPatternCatalog.js';
import { loadCatalogFile } from './stateUiLibrary.js';

const TOP_NAV: PatternEntry = Object.freeze({
    name: 'top-nav',
    kind: 'shell',
    summary: 'A header with links over the screen',
    purposes: ['site header'],
    tree: { component: 'page', children: { body: { component: 'outlet' } } },
    slots: {},
    params: {}
}) as PatternEntry;

const real = (): StateUiPatternCatalog => new StateUiPatternCatalog(loadCatalogFile());

describe('StateUiPatternCatalog', () => {
    describe('get and preset', () => {
        it('should find the library patterns of the built catalog by name, and no preset yet', () => {
            // Arrange
            const catalog = real();

            // Act
            const pattern = catalog.get('product-detail');
            const missing = catalog.get('checkout');
            const preset = catalog.preset('halo');

            // Assert
            expect(pattern?.kind).toBe('screen');
            expect(missing).toBeUndefined();
            expect(preset).toBeUndefined();
        });

        it('should find a pattern of a patterns section by name', () => {
            // Arrange
            const catalog = new StateUiPatternCatalog({ patterns: [TOP_NAV] });

            // Act
            const found = catalog.get('top-nav');
            const missing = catalog.get('side-nav');

            // Assert
            expect(found).toBe(TOP_NAV);
            expect(missing).toBeUndefined();
        });
    });

    describe('search', () => {
        it('should rank product-detail first for an online store product page', () => {
            // Arrange
            const catalog = real();

            // Act
            const result = catalog.search({ need: 'online store product page' });

            // Assert
            expect(result.weak).toBe(false);
            expect(result.results[0]?.name).toBe('product-detail');
            expect(result.results[0]?.source).toBe('library');
            expect(result.results[0]?.slots).toHaveProperty('detail');
            expect(result.results[0]?.params['product']?.type).toBe('path');
        });

        it('should rank sign-in-form first for sign in', () => {
            // Arrange
            const catalog = real();

            // Act
            const result = catalog.search({ need: 'sign in' });

            // Assert
            expect(result.weak).toBe(false);
            expect(result.results[0]?.name).toBe('sign-in-form');
            expect(result.results[0]?.components.length).toBeGreaterThan(0);
        });

        it.each([
            ['book a room for some dates', 'booking'],
            ['a personal finance dashboard with income and spending charts', 'dashboard']
        ])('should rank the pattern of a measured request first: %s', (need, name) => {
            // Arrange
            const catalog = real();

            // Act
            const result = catalog.search({ need });

            // Assert
            expect(result.weak).toBe(false);
            expect(result.results[0]?.name).toBe(name);
        });

        it('should answer a need that matches nothing with every pattern, marked weak', () => {
            // Arrange
            const catalog = real();

            // Act
            const result = catalog.search({ need: 'xyzzy', limit: 20 });

            // Assert
            expect(result.weak).toBe(true);
            expect(result.results.map((hit) => hit.name).sort()).toEqual([...catalog.names()].sort());
            expect(result.results.every((hit) => hit.matched.length === 0)).toBe(true);
        });

        it('should answer kind shell with only shells, or with the weak result of the other kind while the library has none', () => {
            // Arrange
            const catalog = real();
            const hasShells = loadCatalogFile().patterns.some((pattern) => pattern.kind === 'shell');

            // Act
            const result = catalog.search({ need: 'app frame with a side nav', kind: 'shell' });

            // Assert
            expect(result.results.length).toBeGreaterThan(0);
            if (hasShells) {
                expect(result.results.every((hit) => hit.kind === 'shell')).toBe(true);
            } else {
                expect(result.weak).toBe(true);
                expect(result.results.some((hit) => hit.kind === 'shell')).toBe(false);
            }
        });

        it('should keep to the kind asked for', () => {
            // Arrange
            const catalog = new StateUiPatternCatalog({ patterns: [TOP_NAV, ...loadCatalogFile().patterns] });

            // Act
            const shells = catalog.search({ need: 'product page', kind: 'shell' });
            const screens = catalog.search({ need: 'site header', kind: 'screen' });

            // Assert
            expect(shells.results.length).toBeGreaterThan(0);
            expect(shells.results.every((hit) => hit.kind === 'shell')).toBe(true);
            expect(screens.results.length).toBeGreaterThan(0);
            expect(screens.results.every((hit) => hit.kind === 'screen')).toBe(true);
        });

        it('should mark weak a best match that holds no purpose phrase', () => {
            // Arrange
            const catalog = new StateUiPatternCatalog({ patterns: [TOP_NAV] });

            // Act
            const byPurpose = catalog.search({ need: 'header' });
            const bySummary = catalog.search({ need: 'links' });

            // Assert
            expect(byPurpose.weak).toBe(false);
            expect(bySummary.results[0]?.name).toBe('top-nav');
            expect(bySummary.weak).toBe(true);
        });

        it('should cap the limit at 20 and raise it to at least 1', () => {
            // Arrange
            const many = Array.from({ length: 25 }, (_, index) => ({ ...TOP_NAV, name: `nav-${String(index).padStart(2, '0')}` }));
            const catalog = new StateUiPatternCatalog({ patterns: many });

            // Act
            const capped = catalog.search({ need: 'site header', limit: 50 });
            const raised = catalog.search({ need: 'site header', limit: 0 });

            // Assert
            expect(capped.results).toHaveLength(20);
            expect(raised.results).toHaveLength(1);
        });

        it('should throw InvalidSearchArgumentError for an unknown kind', () => {
            // Arrange
            const catalog = real();

            // Act and Assert
            expect(() => catalog.search({ need: 'sign in', kind: 'page' })).toThrow(InvalidSearchArgumentError);
        });
    });
    describe('withOwner', () => {
        const OWN_FRAME = Object.freeze({ ...TOP_NAV, summary: 'Our own header frame', purposes: ['site header', 'our frame'] });

        it('should leave out an owner pattern with a library name, so get never meets two patterns of one name', () => {
            // Arrange
            const catalog = new StateUiPatternCatalog({ patterns: [TOP_NAV] }).withOwner([
                { name: 'top-nav', body: { ...OWN_FRAME, summary: 'A copy with the library name' } },
                { name: 'own-frame', body: OWN_FRAME }
            ]);

            // Act
            const library = catalog.get('top-nav');
            const owner = catalog.get('own-frame');

            // Assert
            expect(library).toMatchObject({ summary: TOP_NAV.summary });
            expect(library?.source ?? 'library').toBe('library');
            expect(owner).toMatchObject({ source: 'owner', summary: OWN_FRAME.summary });
            expect(catalog.names()).toEqual(['top-nav', 'own-frame']);
        });

        it('should rank an owner pattern with the purpose of a library pattern beside it, each with its source', () => {
            // Arrange
            const catalog = new StateUiPatternCatalog({ patterns: [TOP_NAV] }).withOwner([{ name: 'own-frame', body: OWN_FRAME }]);

            // Act
            const { results } = catalog.search({ need: 'site header' });

            // Assert
            expect(results.map((hit) => [hit.name, hit.source]).sort()).toEqual([
                ['own-frame', 'owner'],
                ['top-nav', 'library']
            ]);
        });
    });
});
