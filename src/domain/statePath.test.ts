import { describe, it, expect } from 'vitest';
import { parseStatePath } from './statePath.js';

describe('parseStatePath', () => {
    it('should read a data path', () => {
        expect(parseStatePath('$.data.order.customer')).toEqual({ kind: 'data', path: ['order', 'customer'] });
    });

    it('should read the data root as an empty path', () => {
        expect(parseStatePath('$.data')).toEqual({ kind: 'data', path: [] });
    });

    it('should read an app path', () => {
        expect(parseStatePath('$.app.children.name.value')).toEqual({
            kind: 'app',
            path: ['children', 'name', 'value']
        });
    });

    it('should mark a runtime path', () => {
        expect(parseStatePath('$.runtime.nodes.app')).toEqual({ kind: 'runtime' });
    });

    it.each(['$', '$.theme.tokens', '$.locale'])('should call "%s" unknown', (text) => {
        expect(parseStatePath(text)).toEqual({ kind: 'unknown' });
    });

    it('should reject a path without the $ root', () => {
        expect(parseStatePath('data.x')).toEqual({ kind: 'invalid', reason: 'A state path starts with $' });
    });

    it('should reject an empty segment', () => {
        expect(parseStatePath('$.data..x')).toEqual({ kind: 'invalid', reason: 'A path segment is empty' });
    });
});
