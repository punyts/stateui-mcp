import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from './UiApp.js';

describe('UiApp', () => {
    describe('createEmptyDocument', () => {
        it('should hold a single page root', () => {
            expect(createEmptyDocument()).toEqual({ app: { component: 'page' } });
        });

        it('should return a new object on every call', () => {
            expect(createEmptyDocument()).not.toBe(createEmptyDocument());
        });
    });
});
