import { describe, it, expect } from 'vitest';
import { isBlockingError, isValid } from './UiBuildError.js';
import type { UiBuildError } from './UiBuildError.js';

const ERROR: UiBuildError = Object.freeze({ code: 'SUI-DOC-KEY', message: 'm' });
const EXPLICIT_ERROR: UiBuildError = Object.freeze({ code: 'SUI-DOC-KEY', message: 'm', severity: 'error' });
const WARNING: UiBuildError = Object.freeze({ code: 'SUI-LOCALE-MISSING', message: 'm', severity: 'warning' });

describe('UiBuildError', () => {
    describe('isBlockingError', () => {
        it('should treat an absent severity as an error', () => {
            expect(isBlockingError(ERROR)).toBe(true);
            expect(isBlockingError(EXPLICIT_ERROR)).toBe(true);
        });

        it('should not block on a warning', () => {
            expect(isBlockingError(WARNING)).toBe(false);
        });
    });

    describe('isValid', () => {
        it('should be valid with no errors or only warnings', () => {
            expect(isValid([])).toBe(true);
            expect(isValid([WARNING])).toBe(true);
        });

        it('should be invalid when any error is present', () => {
            expect(isValid([WARNING, ERROR])).toBe(false);
        });
    });
});
