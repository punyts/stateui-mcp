import { describe, it, expect } from 'vitest';
import { INITIAL_REVISION, isRevision, isRevisionCurrent, nextRevision } from './revision.js';

describe('revision', () => {
    describe('nextRevision', () => {
        it('should raise the revision by one', () => {
            // Arrange
            const current = 7;

            // Act
            const next = nextRevision(current);

            // Assert
            expect(next).toBe(8);
        });

        it('should give 2 after the initial revision', () => {
            expect(nextRevision(INITIAL_REVISION)).toBe(2);
        });

        it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('should throw for the invalid revision %s', (value) => {
            expect(() => nextRevision(value)).toThrow(RangeError);
        });
    });

    describe('isRevision', () => {
        it('should accept positive integers and reject everything else', () => {
            expect(isRevision(1)).toBe(true);
            expect(isRevision(0)).toBe(false);
            expect(isRevision(2.5)).toBe(false);
            expect(isRevision('1')).toBe(false);
        });
    });

    describe('isRevisionCurrent', () => {
        it('should pass when no revision is expected', () => {
            expect(isRevisionCurrent(4, undefined)).toBe(true);
        });

        it('should pass when the expected revision equals the current one', () => {
            expect(isRevisionCurrent(4, 4)).toBe(true);
        });

        it('should fail when the expected revision is stale', () => {
            expect(isRevisionCurrent(4, 3)).toBe(false);
        });
    });
});
