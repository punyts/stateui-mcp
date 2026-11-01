import { describe, it, expect } from 'vitest';
import { nearestNames } from './nearestNames.js';

describe('nearestNames', () => {
    const known = ['text', 'textField', 'textarea', 'button', 'list'];

    it('should put the closest name first', () => {
        expect(nearestNames('textFeild', known)[0]).toBe('textField');
    });

    it('should ignore case', () => {
        expect(nearestNames('BUTTON', known)).toEqual(['button']);
    });

    it('should list at most three names', () => {
        expect(nearestNames('text', ['text1', 'text2', 'text3', 'text4'])).toHaveLength(3);
    });

    it('should return nothing when no name is near', () => {
        expect(nearestNames('qqqqqqqqqq', known)).toEqual([]);
    });
});
