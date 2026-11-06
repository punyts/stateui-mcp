import { describe, expect, it } from 'vitest';
import { treeOf } from './partAppCheck.js';
import type { PatternCatalog, PatternEntry } from './ports/PatternCatalog.js';

const CHECKOUT: PatternEntry = Object.freeze({
    name: 'checkout',
    kind: 'screen',
    summary: 'Pay for the bag',
    purposes: ['checkout'],
    tree: Object.freeze({
        component: 'panel',
        _title: 'Checkout',
        children: Object.freeze({ pay: Object.freeze({ component: 'button', _label: 'Pay' }) })
    }),
    slots: Object.freeze({ extras: Object.freeze({ path: 'children', description: 'More views beside the button' }) }),
    params: Object.freeze({
        title: Object.freeze({ type: 'string', default: 'Checkout', paths: Object.freeze(['_title', 'children.pay._label']), description: 'The heading' })
    })
}) as unknown as PatternEntry;

const PATTERNS: PatternCatalog = Object.freeze({
    get: (name: string) => (name === CHECKOUT.name ? CHECKOUT : undefined),
    names: () => [CHECKOUT.name],
    search: () => ({ results: [], weak: true }),
    preset: () => undefined
});

describe('treeOf', () => {
    it('should give a node tree as it is, with no slots', () => {
        // Arrange
        const node = Object.freeze({ component: 'panel' });

        // Act
        const outcome = treeOf({ node }, 'screen', PATTERNS, '$.screens.pay');

        // Assert
        expect(outcome).toEqual({ kind: 'tree', tree: node, slots: [] });
    });

    it('should copy the tree of a pattern with its defaults and give the slots as node paths in the app', () => {
        // Act
        const outcome = treeOf({ pattern: 'checkout' }, 'screen', PATTERNS, '$.screens.pay');

        // Assert
        expect(outcome).toEqual({
            kind: 'tree',
            tree: { component: 'panel', _title: 'Checkout', children: { pay: { component: 'button', _label: 'Checkout' } } },
            slots: [{ name: 'extras', path: '$.screens.pay.children', description: 'More views beside the button' }]
        });
        expect(outcome.kind === 'tree' && outcome.tree).not.toBe(CHECKOUT.tree);
    });

    it('should write a param value at every path of the param', () => {
        // Act
        const outcome = treeOf({ pattern: 'checkout', params: { title: 'Pay now' } }, 'screen', PATTERNS, '$.screens.pay');

        // Assert
        expect(outcome.kind === 'tree' && outcome.tree).toEqual({
            component: 'panel',
            _title: 'Pay now',
            children: { pay: { component: 'button', _label: 'Pay now' } }
        });
    });

    it('should refuse an unknown pattern with the nearest names, and a pattern of the other kind', () => {
        // Act
        const unknown = treeOf({ pattern: 'chekout' }, 'screen', PATTERNS, '$.screens.pay');
        const wrongKind = treeOf({ pattern: 'checkout' }, 'shell', PATTERNS, '$.app');

        // Assert
        expect(unknown).toEqual({ kind: 'unknown-pattern', pattern: 'chekout', nearest: ['checkout'] });
        expect(wrongKind).toEqual({ kind: 'wrong-pattern-kind', pattern: 'checkout', patternKind: 'screen' });
    });

    it('should refuse an unknown param and a value of the wrong type, naming each param', () => {
        // Act
        const outcome = treeOf({ pattern: 'checkout', params: { title: 3, colour: 'red' } }, 'screen', PATTERNS, '$.screens.pay');

        // Assert
        expect(outcome.kind).toBe('pattern-params');
        expect(outcome.kind === 'pattern-params' && outcome.problems.map((problem) => problem.param).sort()).toEqual(['colour', 'title']);
    });
});
