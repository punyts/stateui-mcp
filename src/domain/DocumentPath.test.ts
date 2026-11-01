import { describe, it, expect } from 'vitest';
import { parseDocumentPath, resolveDocumentPath, toStatePath } from './DocumentPath.js';
import type { JsonValue } from './JsonValue.js';

const DOCUMENT: JsonValue = Object.freeze({
    app: Object.freeze({
        component: 'page',
        children: Object.freeze({ footer: Object.freeze({ component: 'toolbar', _title: 'Footer' }) })
    }),
    data: Object.freeze({ rows: Object.freeze([Object.freeze({ id: 'a' })]) })
});

describe('DocumentPath', () => {
    describe('parseDocumentPath', () => {
        it('should split a dotted path into segments', () => {
            const result = parseDocumentPath('app.children.footer._title');

            expect(result).toEqual({ ok: true, path: ['app', 'children', 'footer', '_title'] });
        });

        it('should parse the empty string as the root', () => {
            expect(parseDocumentPath('')).toEqual({ ok: true, path: [] });
        });

        it.each(['.a', 'a.', 'a..b', '.'])('should reject the path "%s" with an empty segment', (text) => {
            expect(parseDocumentPath(text)).toEqual({ ok: false, reason: 'A path segment is empty' });
        });
    });

    describe('toStatePath', () => {
        it('should give $ for the root and $.a.b otherwise', () => {
            expect(toStatePath([])).toBe('$');
            expect(toStatePath(['app', 'children'])).toBe('$.app.children');
        });
    });

    describe('resolveDocumentPath', () => {
        it('should return the root for the empty path', () => {
            expect(resolveDocumentPath(DOCUMENT, [])).toEqual({ found: true, value: DOCUMENT });
        });

        it('should walk object keys', () => {
            const result = resolveDocumentPath(DOCUMENT, ['app', 'children', 'footer', '_title']);

            expect(result).toEqual({ found: true, value: 'Footer' });
        });

        it('should walk array indexes', () => {
            const result = resolveDocumentPath(DOCUMENT, ['data', 'rows', '0', 'id']);

            expect(result).toEqual({ found: true, value: 'a' });
        });

        it('should report the first missing object key', () => {
            const result = resolveDocumentPath(DOCUMENT, ['app', 'children', 'header', 'children', 'x']);

            expect(result).toEqual({ found: false, missingAt: 2 });
        });

        it('should report an array index out of range and a non-numeric index', () => {
            expect(resolveDocumentPath(DOCUMENT, ['data', 'rows', '1'])).toEqual({ found: false, missingAt: 2 });
            expect(resolveDocumentPath(DOCUMENT, ['data', 'rows', 'x'])).toEqual({ found: false, missingAt: 2 });
        });

        it('should report a segment below a scalar', () => {
            const result = resolveDocumentPath(DOCUMENT, ['app', 'component', 'x']);

            expect(result).toEqual({ found: false, missingAt: 2 });
        });

        it('should not follow inherited keys', () => {
            expect(resolveDocumentPath(DOCUMENT, ['toString'])).toEqual({ found: false, missingAt: 0 });
        });
    });
});
