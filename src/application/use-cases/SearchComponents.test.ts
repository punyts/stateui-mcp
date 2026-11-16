import { describe, expect, it, vi } from 'vitest';
import { InvalidSearchArgumentError } from '../ports/ComponentCatalog.js';
import type { ComponentSearchResult } from '../ports/ComponentCatalog.js';
import { SearchComponents } from './SearchComponents.js';

const RESULT: ComponentSearchResult = Object.freeze({ results: Object.freeze([]), weak: true });

describe('SearchComponents', () => {
    it('should return the ranking of the catalog', async () => {
        // Arrange
        const search = vi.fn().mockReturnValue(RESULT);
        const useCase = new SearchComponents({ search, list: () => [] });

        // Act
        const outcome = await useCase.execute({ need: 'pick a date', limit: 3 });

        // Assert
        expect(outcome).toEqual({ kind: 'found', result: RESULT });
        expect(search).toHaveBeenCalledWith({ need: 'pick a date', limit: 3 }, []);
    });

    it('should answer an unknown category or tier with the allowed values', async () => {
        // Arrange
        const useCase = new SearchComponents({
            list: () => [],
            search: () => {
                throw new InvalidSearchArgumentError('tier', ['composed', 'root']);
            }
        });

        // Act
        const outcome = await useCase.execute({ need: 'x', tier: 'shape' });

        // Assert
        expect(outcome).toEqual({ kind: 'invalid-argument', argument: 'tier', allowed: ['composed', 'root'] });
    });

    it('should let any other error through', async () => {
        const useCase = new SearchComponents({
            list: () => [],
            search: () => {
                throw new Error('broken');
            }
        });

        await expect(useCase.execute({ need: 'x' })).rejects.toThrow('broken');
    });

    describe('by meaning', () => {
        const SUMMARY = { name: 'dateRangeField', tier: 'root' as const, size: 'm', summary: 'Two dates', category: 'forms', purposes: ['choose start and end dates'] };
        const STRONG: ComponentSearchResult = Object.freeze({ results: Object.freeze([]), weak: false });
        const MEANING = Object.freeze({ ranked: Object.freeze(['dateRangeField']), close: true });

        it('should ask the meaning of a weak need, with the library texts, and search again with it', async () => {
            // Arrange
            const search = vi.fn().mockReturnValue(RESULT);
            const rank = vi.fn().mockResolvedValue(MEANING);
            const useCase = new SearchComponents({ search, list: () => [SUMMARY] }, undefined, { rank });

            // Act
            await useCase.execute({ need: 'holiday from and to' });

            // Assert
            expect(rank).toHaveBeenCalledWith('component', 'holiday from and to', [{ name: 'dateRangeField', text: 'date range field. Two dates For: choose start and end dates.' }], 20);
            expect(search).toHaveBeenLastCalledWith({ need: 'holiday from and to' }, [], MEANING);
        });

        it('should not ask the meaning of a need the words answer well', async () => {
            // Arrange
            const rank = vi.fn();
            const useCase = new SearchComponents({ search: () => STRONG, list: () => [SUMMARY] }, undefined, { rank });

            // Act
            const outcome = await useCase.execute({ need: 'pick a date range' });

            // Assert
            expect(outcome).toEqual({ kind: 'found', result: STRONG });
            expect(rank).not.toHaveBeenCalled();
        });

        it('should keep the keyword result when the meaning cannot be had', async () => {
            // Arrange
            const search = vi.fn().mockReturnValue(RESULT);
            const useCase = new SearchComponents({ search, list: () => [SUMMARY] }, undefined, { rank: () => Promise.reject(new Error('no model')) });

            // Act
            const outcome = await useCase.execute({ need: 'holiday from and to' });

            // Assert
            expect(outcome).toEqual({ kind: 'found', result: RESULT });
            expect(search).toHaveBeenLastCalledWith({ need: 'holiday from and to' }, [], undefined);
        });
    });
});
