import { describe, expect, it } from 'vitest';
import type { JsonObject } from './JsonValue.js';
import { applyNodeOperation, childKey, removePruning, treePath, treeStatePath, withTreeStatePath } from './nodeOperations.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const HOLDER = deepFreeze({
    root: { component: 'panel', children: { title: { component: 'text', _text: 'Hi' }, body: { component: 'panel' } } }
}) as unknown as JsonObject;

const SCREEN = { kind: 'screen', screen: 'product' } as const;
const SHELL = { kind: 'app' } as const;

describe('treePath', () => {
    it('should keep a root path and map the run-time forms of the tree', () => {
        // Act
        const paths = [
            treePath('root.children.hero', SCREEN),
            treePath('$.screens.product.children.buy', SCREEN),
            treePath('screens.product', SCREEN),
            treePath('$.app.children.header', SHELL),
            treePath('$.root', SHELL)
        ];

        // Assert
        expect(paths).toEqual(['root.children.hero', 'root.children.buy', 'root', 'root.children.header', 'root']);
    });

    it('should refuse a path of another tree or of no tree', () => {
        // Act
        const paths = [treePath('$.screens.home.children.x', SCREEN), treePath('$.app.children.x', SCREEN), treePath('$.data.x', SHELL), treePath('$', SHELL)];

        // Assert
        expect(paths).toEqual([undefined, undefined, undefined, undefined]);
    });
});

describe('treeStatePath and withTreeStatePath', () => {
    it('should give the run-time path of a tree and map an error under root to it', () => {
        // Arrange
        const error = { code: 'X', message: 'm', statePath: '$.root.children.a' };
        const other = { code: 'X', message: 'm', statePath: '$.rooted' };

        // Act
        const mapped = withTreeStatePath(error, SCREEN);
        const shellRoot = withTreeStatePath({ ...error, statePath: '$.root' }, SHELL);

        // Assert
        expect(treeStatePath(SHELL)).toBe('$.app');
        expect(mapped.statePath).toBe('$.screens.product.children.a');
        expect(shellRoot.statePath).toBe('$.app');
        expect(withTreeStatePath(other, SHELL)).toBe(other);
    });
});

describe('childKey', () => {
    it('should use the component name, then number it, and fall back to node', () => {
        // Act / Assert
        expect(childKey('button', [])).toBe('button');
        expect(childKey('button', ['button', 'button2'])).toBe('button3');
        expect(childKey('3d', [])).toBe('node');
    });
});

describe('applyNodeOperation', () => {
    it('should add a child under a generated key and return its path', () => {
        // Act
        const result = applyNodeOperation(HOLDER, { op: 'add', path: 'root', value: { component: 'text', _text: 'More' } });

        // Assert
        expect(result).toMatchObject({ ok: true, added: 'root.children.text' });
        if (!result.ok) return;
        expect(Object.keys((result.tree['root'] as { children: object }).children)).toEqual(['title', 'body', 'text']);
    });

    it('should add a child with a key before a sibling, and to a node without children', () => {
        // Act
        const before = applyNodeOperation(HOLDER, { op: 'add', path: 'root', key: 'lead', before: 'title', value: { component: 'text' } });
        const leaf = applyNodeOperation(HOLDER, { op: 'add', path: 'root.children.body', value: { component: 'button' } });

        // Assert
        expect(before.ok && Object.keys((before.tree['root'] as { children: object }).children)).toEqual(['lead', 'title', 'body']);
        expect(leaf).toMatchObject({ ok: true, added: 'root.children.body.children.button' });
    });

    it('should refuse an add to no node, a value without a component and a taken key', () => {
        // Act
        const noNode = applyNodeOperation(HOLDER, { op: 'add', path: 'root.children.nope', value: { component: 'text' } });
        const content = applyNodeOperation(HOLDER, { op: 'add', path: 'root.children.title._text', value: { component: 'text' } });
        const noComponent = applyNodeOperation(HOLDER, { op: 'add', path: 'root', value: { _text: 'x' } });
        const taken = applyNodeOperation(HOLDER, { op: 'add', path: 'root', key: 'title', value: { component: 'text' } });

        // Assert
        expect(noNode).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH' } });
        expect(content).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH' } });
        expect(noComponent).toMatchObject({ ok: false, error: { code: 'SUI-DOC-OPERATION' } });
        expect(taken).toMatchObject({ ok: false, error: { code: 'SUI-DOC-PATH', statePath: '$.root.children.title' } });
    });

    it('should apply the document operations', () => {
        // Act
        const set = applyNodeOperation(HOLDER, { op: 'set', path: 'root.children.title._text', value: 'Hello' });

        // Assert
        expect(set.ok && (set.tree['root'] as { children: { title: { _text: string } } }).children.title._text).toBe('Hello');
    });
});

describe('removePruning', () => {
    it('should remove the value and every object it leaves empty', () => {
        // Arrange
        const overlay = deepFreeze({ root: { children: { title: { _text: 'Hallo' } } } }) as unknown as JsonObject;

        // Act
        const result = removePruning(overlay, ['root', 'children', 'title', '_text']);

        // Assert
        expect(result).toEqual({ ok: true, tree: {} });
    });
});
