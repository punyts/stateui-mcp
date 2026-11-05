import { describe, expect, it } from 'vitest';
import { treeOf } from './partAppCheck.js';
import type { PatternCatalog, PatternEntry } from './ports/PatternCatalog.js';

const CHECKOUT: PatternEntry = Object.freeze({
    name: 'checkout',
    kind: 'screen',
    summary: 'Pay for the bag',
    purposes: ['checkout'],
    tree: Object.freeze({ component: 'panel', children: Object.freeze({ pay: Object.freeze({ component: 'button' }) }) }),
    slots: {},
    params: {}
}) as PatternEntry;

const PATTERNS: PatternCatalog = Object.freeze({
    get: (name: string) => (name === CHECKOUT.name ? CHECKOUT : undefined),
    preset: () => undefined
});

describe('treeOf', () => {
    it('should give a node tree as it is', () => {
        // Arrange
        const node = Object.freeze({ component: 'panel' });

        // Act
        const outcome = treeOf({ node }, 'screen', PATTERNS);

        // Assert
        expect(outcome).toEqual({ kind: 'tree', tree: node });
    });

    it('should copy the tree of a pattern of the wanted kind', () => {
        // Act
        const outcome = treeOf({ pattern: 'checkout' }, 'screen', PATTERNS);

        // Assert
        expect(outcome).toEqual({ kind: 'tree', tree: CHECKOUT.tree });
        expect(outcome.kind === 'tree' && outcome.tree).not.toBe(CHECKOUT.tree);
    });

    it('should refuse an unknown pattern, a pattern of the other kind and pattern params', () => {
        // Act
        const unknown = treeOf({ pattern: 'cart' }, 'screen', PATTERNS);
        const wrongKind = treeOf({ pattern: 'checkout' }, 'shell', PATTERNS);
        const params = treeOf({ pattern: 'checkout', params: { title: 'Pay' } }, 'screen', PATTERNS);

        // Assert
        expect(unknown).toEqual({ kind: 'unknown-pattern', pattern: 'cart' });
        expect(wrongKind).toEqual({ kind: 'wrong-pattern-kind', pattern: 'checkout', patternKind: 'screen' });
        expect(params).toEqual({ kind: 'pattern-params', pattern: 'checkout' });
    });
});
