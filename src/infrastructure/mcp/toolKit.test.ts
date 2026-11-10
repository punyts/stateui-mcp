import { describe, expect, it } from 'vitest';
import { defineInput, documentPath, statePath } from './toolKit.js';

const INPUT = defineInput({
    value: { type: 'json', required: true, description: 'Any JSON value' },
    object: { type: 'object', description: 'An object' },
    items: { type: 'list', maxItems: 2, description: 'Items', items: { name: { type: 'string', required: true, allowEmpty: true, description: 'A name' } } }
});

class Instance {
    readonly x = 1;
}

describe('defineInput json and list fields', () => {
    it('should accept every JSON type, including null and nested values', () => {
        for (const value of ['text', 1.5, true, null, [1, { a: [null] }], { a: { b: 'c' } }]) {
            expect(INPUT.parse({ value }).ok, JSON.stringify(value)).toBe(true);
        }
    });

    it('should reject values that are not JSON', () => {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, 10n, Symbol('s'), new Date(), new Instance(), { a: [undefined, () => 1] }, [Number.NaN]]) {
            const result = INPUT.parse({ value });

            expect(result, String(value)).toMatchObject({ ok: false, argument: 'value' });
        }
        expect(INPUT.parse({ value: 1, object: { a: Number.NaN } })).toMatchObject({ ok: false, argument: 'object' });
    });

    it('should name the item and field of a list problem and enforce its length', () => {
        expect(INPUT.parse({ value: 1, items: [{ name: '' }, { name: 'b' }] }).ok).toBe(true);
        expect(INPUT.parse({ value: 1, items: [{ name: 'a' }, {}] })).toMatchObject({ ok: false, argument: 'items[1].name' });
        expect(INPUT.parse({ value: 1, items: [{ name: 'a', extra: 1 }] })).toMatchObject({ ok: false, argument: 'items[0].extra' });
        expect(INPUT.parse({ value: 1, items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })).toMatchObject({ ok: false, argument: 'items' });
        expect(INPUT.parse({ value: 1, items: ['x'] })).toMatchObject({ ok: false, argument: 'items[0]' });
    });

    it('should describe a json field without a type and a list field as an array of objects', () => {
        const { properties, required } = INPUT.schema;

        expect(properties['value']).toEqual({ description: 'Any JSON value' });
        expect(properties['items']).toMatchObject({ type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['name'] } });
        expect(required).toEqual(['value']);
    });

    it('should describe a json field with a schema by that schema, so a model sends a list and not a string', () => {
        const names = defineInput({ names: { type: 'json', schema: { type: 'array', items: { type: 'string' } }, description: 'Names' } });

        expect(names.schema.properties['names']).toEqual({ type: 'array', items: { type: 'string' }, description: 'Names' });
    });
});

describe('documentPath and statePath', () => {
    it('should turn a path given either way into a document path and a state path', () => {
        // Arrange
        const paths = Object.freeze(['$.app.children.main', 'app.children.main', '$', '']);

        // Act
        const documents = paths.map(documentPath);
        const states = paths.map(statePath);

        // Assert
        expect(documents).toEqual(['app.children.main', 'app.children.main', '', '']);
        expect(states).toEqual(['$.app.children.main', '$.app.children.main', '$', '$']);
    });
});
