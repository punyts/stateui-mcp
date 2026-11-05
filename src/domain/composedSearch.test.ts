import { describe, expect, it } from 'vitest';
import { isSearchable, mergeSearch, searchFieldProblem } from './composedSearch.js';
import type { ComposedSearch } from './composedSearch.js';

const STORED: ComposedSearch = Object.freeze({
    summary: 'A field for a price',
    category: 'forms',
    purposes: Object.freeze(['enter a price', 'edit a cost', 'type an amount'])
});

describe('searchFieldProblem', () => {
    it('should pass valid fields, fields left out, and empty fields that mean remove', () => {
        // Act
        const problems = [searchFieldProblem(STORED), searchFieldProblem({}), searchFieldProblem({ summary: '', category: '', purposes: [] })];

        // Assert
        expect(problems).toEqual([undefined, undefined, undefined]);
    });

    it('should name the field each broken rule belongs to', () => {
        // Act
        const fields = [
            searchFieldProblem({ summary: '   ' }),
            searchFieldProblem({ summary: 42 }),
            searchFieldProblem({ summary: 'a\r\nb' }),
            searchFieldProblem({ summary: 'x'.repeat(121) }),
            searchFieldProblem({ category: 'widgets' }),
            searchFieldProblem({ purposes: ['one', 'two'] }),
            searchFieldProblem({ purposes: 'enter a price' })
        ].map((problem) => problem?.field);

        // Assert
        expect(fields).toEqual(['summary', 'summary', 'summary', 'summary', 'category', 'purposes', 'purposes']);
    });

    it('should accept a summary of exactly the maximum length', () => {
        // Act
        const problem = searchFieldProblem({ summary: 'x'.repeat(120) });

        // Assert
        expect(problem).toBeUndefined();
    });
});

describe('mergeSearch', () => {
    it('should keep each stored field the write leaves out', () => {
        // Act
        const merged = mergeSearch(STORED, { summary: 'A field for a cost' });

        // Assert
        expect(merged).toEqual({ ...STORED, summary: 'A field for a cost' });
    });

    it('should remove each field given empty', () => {
        // Act
        const merged = mergeSearch(STORED, { summary: '', category: '', purposes: [] });

        // Assert
        expect(merged).toEqual({});
    });
});

describe('isSearchable', () => {
    it('should be true only with all three fields', () => {
        // Act
        const results = [isSearchable(STORED), isSearchable({ summary: STORED.summary, category: 'forms' }), isSearchable({})];

        // Assert
        expect(results).toEqual([true, false, false]);
    });
});
