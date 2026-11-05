import { describe, expect, it, vi } from 'vitest';
import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import type { ComponentSearchResult } from '../ports/ComponentCatalog.js';
import { SearchComponents } from './SearchComponents.js';

const RESULT: ComponentSearchResult = Object.freeze({ results: Object.freeze([]), weak: true });

describe('SearchComponents', () => {
    it('should return the ranking of the catalog', () => {
        // Arrange
        const search = vi.fn().mockReturnValue(RESULT);
        const useCase = new SearchComponents({ search });

        // Act
        const outcome = useCase.execute({ need: 'pick a date', limit: 3 });

        // Assert
        expect(outcome).toEqual({ kind: 'found', result: RESULT });
        expect(search).toHaveBeenCalledWith({ need: 'pick a date', limit: 3 });
    });

    it('should answer an unknown category or tier with the allowed values', () => {
        // Arrange
        const useCase = new SearchComponents({
            search: () => {
                throw new InvalidSearchArgumentError('tier', ['composed', 'root']);
            }
        });

        // Act
        const outcome = useCase.execute({ need: 'x', tier: 'shape' });

        // Assert
        expect(outcome).toEqual({ kind: 'invalid-argument', argument: 'tier', allowed: ['composed', 'root'] });
    });

    it('should let any other error through', () => {
        const useCase = new SearchComponents({
            search: () => {
                throw new Error('broken');
            }
        });

        expect(() => useCase.execute({ need: 'x' })).toThrow('broken');
    });
});
