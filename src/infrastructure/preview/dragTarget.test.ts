import { describe, expect, it } from 'vitest';
import { DRAG_OFFSET_FORM, dragTargetOf, formatDragOffset } from './dragTarget.js';

describe('dragTargetOf', () => {
    it('should read an offset with a sign on each part', () => {
        expect(dragTargetOf('+40,-10')).toEqual({ offset: { dx: 40, dy: -10 } });
        expect(dragTargetOf('-5,+0')).toEqual({ offset: { dx: -5, dy: 0 } });
    });

    it('should read an offset without signs and with spaces around the comma', () => {
        expect(dragTargetOf('40,10')).toEqual({ offset: { dx: 40, dy: 10 } });
        expect(dragTargetOf(' +12 , -3 ')).toEqual({ offset: { dx: 12, dy: -3 } });
    });

    it('should read -0 as 0', () => {
        // Act
        const target = dragTargetOf('-0,-0');

        // Assert
        expect(target).toEqual({ offset: { dx: 0, dy: 0 } });
        expect(Object.is((target as { offset: { dx: number } }).offset.dx, 0)).toBe(true);
    });

    it('should read a state path as the drop target', () => {
        expect(dragTargetOf('$.app.children.board.cols.k_done')).toEqual({ path: '$.app.children.board.cols.k_done' });
        expect(dragTargetOf('app.children.trash')).toEqual({ path: 'app.children.trash' });
    });

    it('should refuse a malformed offset, showing the accepted form', () => {
        for (const value of ['+40', '+40,', ',10', '+4.5,+2', '+40,+10,+3', '++4,0', '+40;+10', '+4x,3', '1e3,0', '99999999999999999999,0']) {
            // Act
            const target = dragTargetOf(value);

            // Assert
            expect(target).toEqual({
                error: `drag value "${value}" is not an offset: write ${DRAG_OFFSET_FORM}, two signed whole numbers of page pixels such as +40,-10 (or give the state path of a drop target)`
            });
        }
    });
});

describe('formatDragOffset', () => {
    it('should write each part with its sign', () => {
        expect(formatDragOffset({ dx: 40, dy: -10 })).toBe('+40,-10');
        expect(formatDragOffset({ dx: 0, dy: 3 })).toBe('+0,+3');
    });
});
