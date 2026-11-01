import { describe, it, expect } from 'vitest';
import { isJsonObject } from './JsonValue.js';

describe('isJsonObject', () => {
    it('should accept plain objects only', () => {
        expect(isJsonObject({ a: 1 })).toBe(true);
        expect(isJsonObject([])).toBe(false);
        expect(isJsonObject(null)).toBe(false);
        expect(isJsonObject('x')).toBe(false);
    });
});
