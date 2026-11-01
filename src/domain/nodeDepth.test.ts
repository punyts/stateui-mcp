import { describe, it, expect } from 'vitest';
import type { JsonObject } from './JsonValue.js';
import { childCount, isNodeValue, limitNodeDepth } from './nodeDepth.js';

const TREE: JsonObject = Object.freeze({
    component: 'page',
    footer: Object.freeze({
        component: 'toolbar',
        children: Object.freeze({
            save: Object.freeze({ component: 'button', children: Object.freeze({ x: Object.freeze({ component: 'icon' }) }) })
        })
    }),
    on: Object.freeze({ press: Object.freeze([Object.freeze({ command: 'close' })]) }),
    children: Object.freeze({
        a: Object.freeze({
            component: 'panel',
            children: Object.freeze({
                b: Object.freeze({ component: 'form', children: Object.freeze({ c: Object.freeze({ component: 'text' }) }) })
            })
        }),
        note: 'not a node'
    })
});

describe('isNodeValue', () => {
    it('should accept an object with a string component only', () => {
        expect(isNodeValue({ component: 'text' })).toBe(true);
        expect(isNodeValue({ component: 1 })).toBe(false);
        expect(isNodeValue([])).toBe(false);
        expect(isNodeValue('text')).toBe(false);
    });
});

describe('childCount', () => {
    it('should count children and give zero without them', () => {
        expect(childCount(TREE)).toBe(2);
        expect(childCount({ component: 'text' })).toBe(0);
    });
});

describe('limitNodeDepth', () => {
    it('should summarise every child node at depth 0', () => {
        const result = limitNodeDepth(TREE, 0);

        expect((result['children'] as JsonObject)['a']).toEqual({ component: 'panel', childCount: 1 });
        expect((result['children'] as JsonObject)['note']).toBe('not a node');
    });

    it('should keep one level at depth 1 and summarise below it', () => {
        const result = limitNodeDepth(TREE, 1);

        const a = (result['children'] as JsonObject)['a'] as JsonObject;
        expect(a['component']).toBe('panel');
        expect((a['children'] as JsonObject)['b']).toEqual({ component: 'form', childCount: 1 });
    });

    it('should keep a slot node on the level of its parent and keep lists and plain objects', () => {
        const result = limitNodeDepth(TREE, 0);

        const footer = result['footer'] as JsonObject;
        expect((footer['children'] as JsonObject)['save']).toEqual({ component: 'button', childCount: 1 });
        expect(result['on']).toEqual({ press: [{ command: 'close' }] });
    });

    it('should return the whole tree when the depth is large', () => {
        expect(limitNodeDepth(TREE, 10)).toEqual(TREE);
    });
});
