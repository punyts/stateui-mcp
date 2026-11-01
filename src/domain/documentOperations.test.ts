import { describe, it, expect } from 'vitest';
import { applyOperation, mergeValues, setCreatingParents } from './documentOperations.js';
import type { WriteOperation } from './documentOperations.js';
import type { JsonObject } from './JsonValue.js';

const DOCUMENT: JsonObject = Object.freeze({
    app: Object.freeze({
        component: 'page',
        children: Object.freeze({
            zeta: Object.freeze({ component: 'text', _text: 'z' }),
            alpha: Object.freeze({ component: 'text', _text: 'a' })
        })
    }),
    data: Object.freeze({
        rows: Object.freeze([Object.freeze({ id: 'a' }), Object.freeze({ id: 'b' })]),
        label: 'x'
    })
});

function apply(operation: WriteOperation | Record<string, unknown>) {
    return applyOperation(DOCUMENT, operation as WriteOperation);
}

function documentOf(operation: WriteOperation | Record<string, unknown>): JsonObject {
    const result = apply(operation);
    if (!result.ok) throw new Error(result.error.message);
    return result.document;
}

describe('applyOperation', () => {
    describe('set', () => {
        it('should replace a value in place and keep key order', () => {
            const document = documentOf({ op: 'set', path: 'app.children.zeta._text', value: 'new' });

            const children = (document['app'] as JsonObject)['children'] as JsonObject;
            expect(Object.keys(children)).toEqual(['zeta', 'alpha']);
            expect((children['zeta'] as JsonObject)['_text']).toBe('new');
        });

        it('should not change the input', () => {
            apply({ op: 'set', path: 'app.component', value: 'panel' });

            expect((DOCUMENT['app'] as JsonObject)['component']).toBe('page');
        });

        it('should append a new key', () => {
            const document = documentOf({ op: 'set', path: 'app.children.mm', value: { component: 'text' } });

            const children = (document['app'] as JsonObject)['children'] as JsonObject;
            expect(Object.keys(children)).toEqual(['zeta', 'alpha', 'mm']);
        });

        it('should replace the whole document with an object at the root', () => {
            expect(documentOf({ op: 'set', path: '', value: { app: { component: 'text' } } })).toEqual({
                app: { component: 'text' }
            });
        });

        it('should reject a non-object value at the root', () => {
            const result = apply({ op: 'set', path: '', value: 'x' });

            expect(result).toMatchObject({ ok: false, error: { code: 'SUI-DOC-OPERATION', statePath: '$' } });
        });

        it('should replace a list item and append at the end of a list', () => {
            const replaced = documentOf({ op: 'set', path: 'data.rows.0', value: { id: 'z' } });
            const appended = documentOf({ op: 'set', path: 'data.rows.2', value: { id: 'c' } });

            expect((replaced['data'] as JsonObject)['rows']).toEqual([{ id: 'z' }, { id: 'b' }]);
            expect((appended['data'] as JsonObject)['rows']).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        });

        it('should reject a list position past the end or a name that is not a position', () => {
            expect(apply({ op: 'set', path: 'data.rows.5', value: 1 })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-PATH' }
            });
            expect(apply({ op: 'set', path: 'data.rows.x', value: 1 })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-PATH' }
            });
        });

        it('should write through a list item', () => {
            const document = documentOf({ op: 'set', path: 'data.rows.1.id', value: 'q' });

            expect((document['data'] as JsonObject)['rows']).toEqual([{ id: 'a' }, { id: 'q' }]);
        });

        it('should reject a path through a missing parent with its state path', () => {
            const result = apply({ op: 'set', path: 'app.children.missing.children.x', value: 1 });

            expect(result).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-PATH', statePath: '$.app.children.missing' }
            });
        });

        it('should reject a path through a missing list item', () => {
            const result = apply({ op: 'set', path: 'data.rows.9.id', value: 1 });

            expect(result).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH', statePath: '$.data.rows.9' } });
        });

        it('should reject a path through a value that is not a container', () => {
            const result = apply({ op: 'set', path: 'data.label.x', value: 1 });

            expect(result).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH', statePath: '$.data.label' } });
        });

        it('should reject a set without a value', () => {
            expect(apply({ op: 'set', path: 'data.label' })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-OPERATION' }
            });
        });
    });

    describe('remove', () => {
        it('should delete a child', () => {
            const document = documentOf({ op: 'remove', path: 'app.children.zeta' });

            expect(Object.keys((document['app'] as JsonObject)['children'] as JsonObject)).toEqual(['alpha']);
        });

        it('should delete a list item', () => {
            const document = documentOf({ op: 'remove', path: 'data.rows.0' });

            expect((document['data'] as JsonObject)['rows']).toEqual([{ id: 'b' }]);
        });

        it('should reject removing what is not there', () => {
            expect(apply({ op: 'remove', path: 'app.children.nope' })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-PATH', statePath: '$.app.children.nope' }
            });
            expect(apply({ op: 'remove', path: 'data.rows.7' })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-PATH' }
            });
        });

        it('should reject removing the list position just past the end', () => {
            expect(apply({ op: 'remove', path: 'data.rows.2' })).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH' } });
        });

        it('should report a missing parent below a list item', () => {
            expect(apply({ op: 'set', path: 'data.rows.0.a.b', value: 1 })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-PATH', statePath: '$.data.rows.0.a' }
            });
        });

        it('should reject removing the root', () => {
            expect(apply({ op: 'remove', path: '' })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-PATH', statePath: '$' }
            });
        });
    });

    describe('merge', () => {
        it('should merge key by key, append new keys in order and replace arrays', () => {
            const document = documentOf({
                op: 'merge',
                path: 'app',
                value: { _title: 'T', children: { alpha: { _text: 'A2' }, beta: { component: 'text' } } }
            });

            const app = document['app'] as JsonObject;
            const children = app['children'] as JsonObject;
            expect(Object.keys(app)).toEqual(['component', 'children', '_title']);
            expect(Object.keys(children)).toEqual(['zeta', 'alpha', 'beta']);
            expect(children['alpha']).toEqual({ component: 'text', _text: 'A2' });
        });

        it('should replace an array and treat null as a value', () => {
            const document = documentOf({ op: 'merge', path: 'data', value: { label: null, rows: [1] } });

            expect((document['data'] as JsonObject)['label']).toBeNull();
            expect((document['data'] as JsonObject)['rows']).toEqual([1]);
        });

        it('should create the key when it is missing', () => {
            const document = documentOf({ op: 'merge', path: 'locales', value: { de: { _title: 'T' } } });

            expect(document['locales']).toEqual({ de: { _title: 'T' } });
        });

        it('should merge at the root', () => {
            const document = documentOf({ op: 'merge', path: '', value: { locale: 'en' } });

            expect(Object.keys(document)).toEqual(['app', 'data', 'locale']);
        });

        it('should reject a value that is not an object', () => {
            expect(apply({ op: 'merge', path: 'data', value: 'x' })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-OPERATION', statePath: '$.data' }
            });
            expect(apply({ op: 'merge', path: '', value: [1] })).toMatchObject({
                ok: false,
                error: { code: 'SUI-DOC-OPERATION' }
            });
        });
    });

    describe('move', () => {
        const TREE: JsonObject = Object.freeze({
            app: Object.freeze({
                component: 'page',
                attrs: Object.freeze({ '7': 'seven' }),
                children: Object.freeze({
                    header: Object.freeze({ component: 'text' }),
                    panel: Object.freeze({
                        component: 'panel',
                        children: Object.freeze({
                            form: Object.freeze({
                                component: 'form',
                                children: Object.freeze({ name: Object.freeze({ component: 'textField' }) })
                            }),
                            note: Object.freeze({ component: 'text' })
                        })
                    }),
                    footer: Object.freeze({ component: 'toolbar', children: Object.freeze({}) }),
                    list: Object.freeze([Object.freeze({ id: 1 })])
                })
            })
        });

        function moved(operation: Record<string, unknown>): JsonObject {
            const result = applyOperation(TREE, operation as unknown as WriteOperation);
            if (!result.ok) throw new Error(result.error.message);
            return result.document;
        }

        function childrenAt(document: JsonObject, ...path: string[]): string[] {
            let current: unknown = document;
            for (const segment of path) current = (current as Record<string, unknown>)[segment];
            return Object.keys(current as JsonObject);
        }

        function failed(operation: Record<string, unknown>) {
            const result = applyOperation(TREE, operation as unknown as WriteOperation);
            if (result.ok) throw new Error('expected a failure');
            return result.error;
        }

        it('should place an entry before a sibling in its own map', () => {
            const document = moved({ op: 'move', path: 'app.children.footer', before: 'header' });

            expect(childrenAt(document, 'app', 'children')).toEqual(['footer', 'header', 'panel', 'list']);
        });

        it('should place an entry after a sibling in its own map', () => {
            const document = moved({ op: 'move', path: 'app.children.header', after: 'footer' });

            expect(childrenAt(document, 'app', 'children')).toEqual(['panel', 'footer', 'header', 'list']);
        });

        it('should move an entry into another map at the end and take its subtree along', () => {
            const document = moved({ op: 'move', path: 'app.children.panel.children.form', to: 'app.children.footer.children' });

            expect(childrenAt(document, 'app', 'children', 'panel', 'children')).toEqual(['note']);
            expect(childrenAt(document, 'app', 'children', 'footer', 'children')).toEqual(['form']);
            const form = ((document['app'] as JsonObject)['children'] as JsonObject)['footer'] as JsonObject;
            expect(((form['children'] as JsonObject)['form'] as JsonObject)['children']).toEqual({ name: { component: 'textField' } });
        });

        it('should move an entry into another map before or after a sibling there', () => {
            const before = moved({ op: 'move', path: 'app.children.header', to: 'app.children.panel.children', before: 'note' });
            const after = moved({ op: 'move', path: 'app.children.header', to: 'app.children.panel.children', after: 'form' });

            expect(childrenAt(before, 'app', 'children', 'panel', 'children')).toEqual(['form', 'header', 'note']);
            expect(childrenAt(after, 'app', 'children', 'panel', 'children')).toEqual(['form', 'header', 'note']);
            expect(childrenAt(before, 'app', 'children')).toEqual(['panel', 'footer', 'list']);
        });

        it('should move a node up into an ancestor map', () => {
            const document = moved({ op: 'move', path: 'app.children.panel.children.form', to: 'app.children', before: 'footer' });

            expect(childrenAt(document, 'app', 'children')).toEqual(['header', 'panel', 'form', 'footer', 'list']);
            expect(childrenAt(document, 'app', 'children', 'panel', 'children')).toEqual(['note']);
        });

        it('should reorder inside the same map when to names that map', () => {
            const document = moved({ op: 'move', path: 'app.children.header', to: 'app.children' });

            expect(childrenAt(document, 'app', 'children')).toEqual(['panel', 'footer', 'list', 'header']);
        });

        it('should not change the input', () => {
            moved({ op: 'move', path: 'app.children.footer', before: 'header' });

            expect(childrenAt(TREE, 'app', 'children')).toEqual(['header', 'panel', 'footer', 'list']);
        });

        it('should fail on a missing sibling and name its state path', () => {
            expect(failed({ op: 'move', path: 'app.children.header', before: 'ghost' })).toMatchObject({
                code: 'SUI-DOC-PATH',
                statePath: '$.app.children.ghost'
            });
            expect(failed({ op: 'move', path: 'app.children.header', after: 'header' })).toMatchObject({ code: 'SUI-DOC-PATH' });
        });

        it('should fail on a missing to map', () => {
            expect(failed({ op: 'move', path: 'app.children.header', to: 'app.children.nowhere.children' })).toMatchObject({
                code: 'SUI-DOC-PATH',
                statePath: '$.app.children.nowhere'
            });
            expect(failed({ op: 'move', path: 'app.children.header', to: 'app.children.footer.children.x' })).toMatchObject({
                code: 'SUI-DOC-PATH'
            });
        });

        it('should fail when to is not a keyed map or is the document root', () => {
            expect(failed({ op: 'move', path: 'app.children.header', to: 'app.children.list' })).toMatchObject({ code: 'SUI-DOC-PATH' });
            expect(failed({ op: 'move', path: 'app.children.header', to: 'app.component' })).toMatchObject({ code: 'SUI-DOC-PATH' });
            expect(failed({ op: 'move', path: 'app.children.header', to: '' })).toMatchObject({ code: 'SUI-DOC-PATH' });
            expect(failed({ op: 'move', path: 'app.children.header', to: 'a..b' })).toMatchObject({ code: 'SUI-DOC-PATH' });
        });

        it('should fail when the key already exists at to', () => {
            const clash = applyOperation(
                { app: { children: { a: { x: 1 }, b: { children: { a: 2 } } } } },
                { op: 'move', path: 'app.children.a', to: 'app.children.b.children' }
            );
            expect(clash).toMatchObject({ ok: false, error: { statePath: '$.app.children.b.children.a' } });
        });

        it('should fail when a node is moved into its own subtree or into itself', () => {
            expect(failed({ op: 'move', path: 'app.children.panel', to: 'app.children.panel.children.form.children' })).toMatchObject({
                code: 'SUI-DOC-PATH'
            });
            expect(failed({ op: 'move', path: 'app.children.panel', to: 'app.children.panel' })).toMatchObject({ code: 'SUI-DOC-PATH' });
        });

        it('should fail on the root app and the document root', () => {
            expect(failed({ op: 'move', path: 'app', to: 'app.children' })).toMatchObject({ code: 'SUI-DOC-PATH', statePath: '$.app' });
            expect(failed({ op: 'move', path: '', to: 'app.children' })).toMatchObject({ code: 'SUI-DOC-PATH', statePath: '$' });
        });

        it('should fail on an entry that is missing or sits in a list', () => {
            expect(failed({ op: 'move', path: 'app.children.ghost', before: 'header' })).toMatchObject({
                code: 'SUI-DOC-PATH',
                statePath: '$.app.children.ghost'
            });
            expect(failed({ op: 'move', path: 'app.children.list.0', to: 'app.children' })).toMatchObject({ code: 'SUI-DOC-PATH' });
        });

        it('should fail on arguments that do not say where the entry goes', () => {
            expect(failed({ op: 'move', path: 'app.children.header' })).toMatchObject({ code: 'SUI-DOC-OPERATION' });
            expect(failed({ op: 'move', path: 'app.children.header', before: 'panel', after: 'footer' })).toMatchObject({ code: 'SUI-DOC-OPERATION' });
            expect(failed({ op: 'move', path: 'app.children.header', before: 1 })).toMatchObject({ code: 'SUI-DOC-OPERATION' });
            expect(failed({ op: 'move', before: 'panel' })).toMatchObject({ code: 'SUI-DOC-PATH' });
            expect(failed({ op: 'move', path: 'a..b', before: 'panel' })).toMatchObject({ code: 'SUI-DOC-PATH' });
        });

        it('should keep an integer-like key so the write check can refuse it', () => {
            const document = moved({ op: 'move', path: 'app.attrs.7', to: 'app.children' });

            expect(childrenAt(document, 'app', 'children')).toContain('7');
        });

        it('should move an entry at the document root', () => {
            const document = applyOperation({ app: { component: 'page' }, data: { a: 1 } }, { op: 'move', path: 'data', before: 'app' });

            expect(document).toEqual({ ok: true, document: { data: { a: 1 }, app: { component: 'page' } } });
        });
    });

    describe('invalid operations', () => {
        it('should reject an unknown op', () => {
            const result = apply({ op: 'rename', path: 'app' });

            expect(result).toMatchObject({ ok: false, error: { code: 'SUI-DOC-OPERATION' } });
            expect(result.ok ? '' : result.error.message).toContain('Unknown operation "rename"; use set, remove, merge, move');
        });

        it('should reject a missing path and a path with an empty segment', () => {
            expect(apply({ op: 'remove' })).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH' } });
            expect(apply({ op: 'remove', path: 'a..b' })).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH' } });
        });
    });
});

describe('mergeValues', () => {
    it('should return the source when the target is not an object', () => {
        expect(mergeValues('x', { a: 1 })).toEqual({ a: 1 });
        expect(mergeValues(undefined, { a: 1 })).toEqual({ a: 1 });
    });

    it('should keep an own __proto__ key as data', () => {
        const source = JSON.parse('{"__proto__": {"x": 1}}') as JsonObject;

        const merged = mergeValues({ a: 1 }, source);

        expect(Object.keys(merged)).toEqual(['a', '__proto__']);
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    });
});

describe('setCreatingParents', () => {
    it('should create the missing parents', () => {
        const result = setCreatingParents({}, ['app', 'children', 'name', 'value'], 'x');

        expect(result).toEqual({ ok: true, document: { app: { children: { name: { value: 'x' } } } } });
    });

    it('should replace the root with an object', () => {
        expect(setCreatingParents({ a: 1 }, [], { b: 2 })).toEqual({ ok: true, document: { b: 2 } });
    });

    it('should reject a non-object root value', () => {
        expect(setCreatingParents({}, [], 3)).toMatchObject({ ok: false, error: { code: 'SUI-DOC-OPERATION' } });
    });

    it('should reject a parent that is not a container', () => {
        expect(setCreatingParents({ a: 'x' }, ['a', 'b'], 1)).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH' } });
    });
});
