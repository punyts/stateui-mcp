import { describe, expect, it } from 'vitest';
import { fieldReaders } from './fieldReaders.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const BODY = deepFreeze({
    shell: { component: 'page', children: { price: { component: 'text', '<-_text': '$.data.products.p1.price' } } },
    logic: {
        rules: {
            reprice: { when: { path: '$.data.products.{id}.price' }, do: [{ command: 'set', target: '$.data.totals.net', value: "{{ sum($.data.products.*.price.amount) }}" }] },
            named: { when: { path: '$.data.products.*.prices' } },
            other: { when: { path: '$.data.orders.o1.price' } }
        }
    }
});

describe('fieldReaders', () => {
    it('should find the paths that read a field of a binding, below a key, a capture or *', () => {
        // Act
        const paths = fieldReaders(BODY, ['products'], ['price']);

        // Assert
        expect(paths).toEqual(['$.data.products.*.price.amount', '$.data.products.p1.price', '$.data.products.{id}.price']);
    });

    it('should skip other fields, other bindings and names that are not key names', () => {
        // Act / Assert
        expect(fieldReaders(BODY, ['products'], ['name'])).toEqual([]);
        expect(fieldReaders(BODY, ['orders'], ['price'])).toEqual(['$.data.orders.o1.price']);
        expect(fieldReaders(BODY, ['prod.ucts'], ['price'])).toEqual([]);
        expect(fieldReaders(BODY, [], ['price'])).toEqual([]);
    });
});
