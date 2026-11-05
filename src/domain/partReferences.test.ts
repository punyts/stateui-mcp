import { describe, expect, it } from 'vitest';
import { componentNames, partReferences, startScreen } from './partReferences.js';
import type { UiPartBodies } from './UiPart.js';

const PATTERN = Object.freeze({
    kind: 'screen',
    tree: Object.freeze({ component: 'stack', children: Object.freeze([Object.freeze({ component: 'card' }), Object.freeze({ component: 'card' })]) })
}) as unknown as UiPartBodies['patterns'];

describe('partReferences', () => {
    it('should find the components of a pattern tree once each, through arrays', () => {
        // Act, Assert
        expect(partReferences('patterns', PATTERN)).toEqual([
            { kind: 'components', name: 'stack' },
            { kind: 'components', name: 'card' }
        ]);
    });

    it('should give nothing for kinds that name no parts and for bodies that do not read as their kind', () => {
        // Act, Assert
        expect(partReferences('themes', { tokens: {} } as UiPartBodies['themes'])).toEqual([]);
        expect(partReferences('models', { fields: {} } as UiPartBodies['models'])).toEqual([]);
        expect(partReferences('data', { records: {} } as UiPartBodies['data'])).toEqual([]);
        expect(partReferences('logic', { needs: 'x' } as unknown as UiPartBodies['logic'])).toEqual([]);
        expect(partReferences('apps', { uses: { themes: 'store', data: { a: 1 } } } as unknown as UiPartBodies['apps'])).toEqual([]);
    });

    it('should read the start screen only when it is a string', () => {
        // Act, Assert
        expect(startScreen({ start: 'home' } as UiPartBodies['apps'])).toBe('home');
        expect(startScreen({} as UiPartBodies['apps'])).toBeUndefined();
    });

    it('should not take a component key that holds no string as a name', () => {
        // Act, Assert
        expect(componentNames({ component: 3, children: { a: { component: 'text' } } })).toEqual(['text']);
    });
});
