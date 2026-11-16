import { describe, expect, it } from 'vitest';
import { diffComplete, planDocumentUpdate } from '../src/browser/documentUpdate.js';
import type { JsonRecord, PathWrite } from '../src/browser/documentUpdate.js';

const text = (value: string): JsonRecord => ({ component: 'text', _text: value });

/** A document whose root panel holds one panel `list` with the given children, in the given order */
function documentWith(children: JsonRecord, list: JsonRecord = { component: 'panel' }): JsonRecord {
    return { app: { component: 'panel', children: { list: { ...list, children } } } };
}

const LIST = '$.app.children.list.children';

describe('the live view host turning a document change into writes', () => {
    it('should remove and write again the children that moved, so they come out in the new order', () => {
        // Arrange
        const before = documentWith({ a: text('alpha'), b: text('beta'), c: text('gamma') });
        const after = documentWith({ c: text('gamma'), a: text('alpha'), b: text('beta') });

        // Act
        const plan = planDocumentUpdate(before, after);

        // Assert
        expect(plan).toEqual([
            { path: `${LIST}.a`, remove: true },
            { path: `${LIST}.b`, remove: true },
            { path: `${LIST}.c`, remove: true },
            { path: `${LIST}.c`, value: text('gamma') },
            { path: `${LIST}.a`, value: text('alpha') },
            { path: `${LIST}.b`, value: text('beta') }
        ]);
    });

    it('should leave the children before the first one out of place alone', () => {
        // Arrange
        const before = documentWith({ a: text('alpha'), b: text('beta'), c: text('gamma') });
        const after = documentWith({ a: text('alpha'), c: text('gamma'), b: text('beta') });

        // Act
        const plan = planDocumentUpdate(before, after);

        // Assert
        expect(plan).toEqual([
            { path: `${LIST}.b`, remove: true },
            { path: `${LIST}.c`, remove: true },
            { path: `${LIST}.c`, value: text('gamma') },
            { path: `${LIST}.b`, value: text('beta') }
        ]);
    });

    it('should put a child added between two others in its place', () => {
        // Arrange
        const before = documentWith({ a: text('alpha'), b: text('beta') });
        const after = documentWith({ a: text('alpha'), n: text('new'), b: text('beta') });

        // Act
        const plan = planDocumentUpdate(before, after);

        // Assert
        expect(plan).toEqual([
            { path: `${LIST}.b`, remove: true },
            { path: `${LIST}.n`, value: text('new') },
            { path: `${LIST}.b`, value: text('beta') }
        ]);
    });

    it('should still append a child added at the end with one write', () => {
        // Act
        const plan = planDocumentUpdate(documentWith({ a: text('alpha') }), documentWith({ a: text('alpha'), n: text('new') }));

        // Assert
        expect(plan).toEqual([{ path: `${LIST}.n`, value: text('new') }]);
    });

    it('should see no change when only the properties of a node are in another order', () => {
        // Arrange
        const before = documentWith({ a: { component: 'text', _text: 'alpha', tone: 'muted' } });
        const after = documentWith({ a: { tone: 'muted', _text: 'alpha', component: 'text' } });

        // Act
        const plan = planDocumentUpdate(before, after);

        // Assert
        expect(plan).toBe('none');
    });

    it('should load when the node that holds the reordered children is itself written whole', () => {
        // Arrange: the container changes component, so the runtime gets it whole and its store merges the old order
        const before = documentWith({ a: text('alpha'), b: text('beta') }, { component: 'panel' });
        const after = documentWith({ b: text('beta'), a: text('alpha') }, { component: 'stack' });

        // Act
        const plan = planDocumentUpdate(before, after);

        // Assert
        expect(plan).toBe('load');
    });

    it('should write a move inside a screen at the screen path the runtime keeps it under', () => {
        // Arrange
        const screen = (children: JsonRecord): JsonRecord => ({
            app: { component: 'app' },
            start: 'home',
            screens: { home: { title: 'Home', root: { component: 'panel', children } } }
        });
        const before = screen({ a: text('alpha'), b: text('beta') });
        const after = screen({ b: text('beta'), a: text('alpha') });

        // Act
        const plan = planDocumentUpdate(before, after);

        // Assert
        expect(plan).toEqual([
            { path: '$.screens.home.children.a', remove: true },
            { path: '$.screens.home.children.b', remove: true },
            { path: '$.screens.home.children.b', value: text('beta') },
            { path: '$.screens.home.children.a', value: text('alpha') }
        ]);
    });

    it('should load when a screen itself changes, not only its root', () => {
        // Arrange
        const screen = (title: string): JsonRecord => ({
            app: { component: 'app' },
            screens: { home: { title, root: { component: 'panel' } } }
        });

        // Act
        const plan = planDocumentUpdate(screen('Home'), screen('Start'));

        // Assert
        expect(plan).toBe('load');
    });

    it('should keep ignoring key order in a diff of the synced data', () => {
        // Arrange
        const writes: PathWrite[] = [];

        // Act
        const complete = diffComplete('$.data', { items: { x: 1, y: 2 } }, { items: { y: 2, x: 1 } }, writes);

        // Assert
        expect(complete).toBe(true);
        expect(writes).toEqual([]);
    });
});
