import { describe, expect, it } from 'vitest';
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

describe('StateUiPatternCatalog', () => {
    it('should find no pattern and no preset in the built catalog, which has neither section yet', () => {
        // Arrange
        const catalog = new StateUiPatternCatalog(loadCatalogFile());

        // Act
        const pattern = catalog.get('checkout');
        const preset = catalog.preset('halo');

        // Assert
        expect(pattern).toBeUndefined();
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
