import { describe, expect, it } from 'vitest';
import { renderedUnder } from './BrowserPreview.js';
import { INTERACTIVE_SHAPE_SELECTOR, isAtOrBelow, shapeActionError, shapeSelector } from './shapeTargets.js';

describe('shapeSelector', () => {
    it('should select the element whose data-shape-path is the state path', () => {
        // Act
        const selector = shapeSelector('$.app.children.map.children.seat');

        // Assert
        expect(selector).toBe('[data-shape-path="$.app.children.map.children.seat"]');
    });

    it('should keep the record key of a repeat copy and a screen path as written', () => {
        // Act
        const copy = shapeSelector('$.screens.home.children.map.children.seats.rows.s12');

        // Assert
        expect(copy).toBe('[data-shape-path="$.screens.home.children.map.children.seats.rows.s12"]');
    });

    it('should escape quotes, backslashes and line breaks so the path stays one attribute value', () => {
        // Act
        const selector = shapeSelector('$.app.children.a"b\\c\nd');

        // Assert
        expect(selector).toBe('[data-shape-path="$.app.children.a\\"b\\\\c\\a d"]');
    });

    it('should select interactive SVG shapes and canvas proxy buttons', () => {
        expect(INTERACTIVE_SHAPE_SELECTOR).toBe('[data-shape-path][role="button"], button[data-shape-path]');
    });
});

describe('isAtOrBelow', () => {
    it('should hold the path itself and the paths below it', () => {
        expect(isAtOrBelow('$.app.children.map', '$.app.children.map')).toBe(true);
        expect(isAtOrBelow('$.app.children.map.children.seat', '$.app.children.map')).toBe(true);
        expect(isAtOrBelow('$.app.children.map.children.seats.rows.s1', '$.app.children.map')).toBe(true);
    });

    it('should not hold a sibling whose key starts with the same letters', () => {
        expect(isAtOrBelow('$.app.children.mapLegend', '$.app.children.map')).toBe(false);
        expect(isAtOrBelow('$.app', '$.app.children.map')).toBe(false);
    });
});

describe('shapeActionError', () => {
    it('should accept click, press, hover, focus, key and drag', () => {
        for (const action of ['click', 'press', 'hover', 'focus', 'key', 'drag'] as const) {
            expect(shapeActionError('$.app.children.map.children.seat', 'circle', action)).toBeUndefined();
        }
    });

    it('should refuse fill, select and choose, naming the shape and the actions it takes', () => {
        for (const action of ['fill', 'select', 'choose'] as const) {
            // Act
            const message = shapeActionError('$.app.children.map.children.seat', 'circle', action);

            // Assert
            expect(message).toBe(`$.app.children.map.children.seat is a shape (circle), which takes click, press, hover, focus, key, not ${action}`);
        }
    });
});

describe('renderedUnder', () => {
    const found = [
        { path: '$.app', component: 'page', visible: true, shape: false },
        { path: '$.app.children.map', component: 'drawing', visible: true, shape: false },
        { path: '$.app.children.map.children.dot', component: 'circle', visible: true, shape: true },
        { path: '$.app.children.map.children.seats.rows.s1', component: 'rect', visible: true, shape: true },
        { path: '$.app.children.map.children.dot', component: 'circle', visible: true, shape: true },
        { path: '$.app.children.mapLegend', component: 'text', visible: true, shape: false }
    ];

    it('should keep the nodes and shapes at or below the path, in page order, each path once', () => {
        // Act
        const nodes = renderedUnder(found, '$.app.children.map');

        // Assert
        expect(nodes).toEqual([
            { path: '$.app.children.map', component: 'drawing', visible: true },
            { path: '$.app.children.map.children.dot', component: 'circle', visible: true },
            { path: '$.app.children.map.children.seats.rows.s1', component: 'rect', visible: true }
        ]);
    });
});
