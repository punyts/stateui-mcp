import { describe, it, expect } from 'vitest';
import { isIntegerLikeKey, orderedMapKeyErrors } from './orderedMap.js';
import type { JsonObject } from './JsonValue.js';

const text = Object.freeze({ component: 'text' });

function statePaths(document: JsonObject): (string | undefined)[] {
    return orderedMapKeyErrors(document).map((error) => error.statePath);
}

describe('orderedMap', () => {
    describe('isIntegerLikeKey', () => {
        it.each(['0', '7', '42', '1000'])('should treat "%s" as integer-like', (key) => {
            expect(isIntegerLikeKey(key)).toBe(true);
        });

        it.each(['', '01', '-1', '1.5', 'o42', '4a', 'a'])('should not treat "%s" as integer-like', (key) => {
            expect(isIntegerLikeKey(key)).toBe(false);
        });
    });

    describe('orderedMapKeyErrors', () => {
        it('should return nothing for a document with prefixed keys', () => {
            const document = Object.freeze({
                app: Object.freeze({ component: 'page', children: Object.freeze({ o42: text, zeta: text }) }),
                data: Object.freeze({ rows: Object.freeze({ o1: 1 }) })
            });

            expect(orderedMapKeyErrors(document)).toEqual([]);
        });

        it.each(['children', 'options', 'columns', 'items', 'steps', 'messages'])(
            'should report an integer-like key in %s with its state path',
            (mapKey) => {
                const document = Object.freeze({
                    app: Object.freeze({ component: 'page', [mapKey]: Object.freeze({ '42': text, ok: text }) })
                });

                const errors = orderedMapKeyErrors(document);

                expect(errors).toHaveLength(1);
                expect(errors[0]?.code).toBe('SUI-DOC-ORDER');
                expect(errors[0]?.statePath).toBe(`$.app.${mapKey}.42`);
                expect(errors[0]?.message).toContain('"42"');
            }
        );

        it('should report integer-like keys in every object under data, including inside arrays', () => {
            const document = Object.freeze({
                app: text,
                data: Object.freeze({
                    list: Object.freeze({ '7': 1 }),
                    nested: Object.freeze([Object.freeze({ '0': 1 })]),
                    fine: Object.freeze({ a: 1 })
                })
            });

            expect(statePaths(document)).toEqual(['$.data.list.7', '$.data.nested.0.0']);
        });

        it('should report keys inside a composed tree', () => {
            const document = Object.freeze({
                app: text,
                composed: Object.freeze({
                    box: Object.freeze({ component: 'panel', children: Object.freeze({ '2': text }) })
                })
            });

            expect(statePaths(document)).toEqual(['$.composed.box.children.2']);
        });

        it('should not report integer-like keys in maps that are not ordered maps', () => {
            const document = Object.freeze({
                app: Object.freeze({ component: 'page', placement: Object.freeze({ '3': 'x' }) }),
                locales: Object.freeze({ '1': 'x' })
            });

            expect(orderedMapKeyErrors(document)).toEqual([]);
        });

        it('should sort the errors by state path', () => {
            const document = Object.freeze({
                app: Object.freeze({
                    component: 'page',
                    children: Object.freeze({ '9': text, '1': text })
                }),
                data: Object.freeze({ '5': 1 })
            });

            expect(statePaths(document)).toEqual(['$.app.children.1', '$.app.children.9', '$.data.5']);
        });

        it('should cope with a missing app, a composed value that is not an object and a deep value', () => {
            let deep: JsonObject = { '1': 1 };
            for (let index = 0; index < 5000; index++) deep = { child: deep };
            const document = Object.freeze({ composed: 'none', data: deep });

            expect(orderedMapKeyErrors(document)).toHaveLength(1);
            expect(orderedMapKeyErrors({})).toEqual([]);
        });
    });
});
