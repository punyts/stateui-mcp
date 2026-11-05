import { describe, expect, it } from 'vitest';
import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';
import { buildServerInstructions, searchWorkflowSection, START_HERE } from './instructions.js';

const INDEX: readonly CategoryIndexEntry[] = Object.freeze([
    Object.freeze({ category: 'forms', count: 12, typical: Object.freeze(['dateRangeField', 'textField', 'select']) }),
    Object.freeze({ category: 'data', count: 7, typical: Object.freeze(['table', 'list', 'chart']) })
]);

describe('searchWorkflowSection', () => {
    it('should list one line per category with its count and typical members', () => {
        // Act
        const text = searchWorkflowSection(INDEX);

        // Assert
        expect(text).toContain('- forms (12): dateRangeField, textField, select');
        expect(text).toContain('- data (7): table, list, chart');
        expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    });

    it('should leave out a category that is not in the index', () => {
        const text = searchWorkflowSection(INDEX);

        expect(text).not.toContain('graphics');
    });

    it('should plan first, then search, get and build in that order', () => {
        const text = searchWorkflowSection(INDEX);

        expect(text.indexOf('Plan before you search')).toBeLessThan(text.indexOf('ui_components_search'));
        expect(text.indexOf('ui_components_search')).toBeLessThan(text.indexOf('ui_component_get'));
        expect(text.indexOf('ui_component_get')).toBeLessThan(text.indexOf('ui_app_create'));
        expect(text).toContain('wait for their OK');
        expect(text).toContain('guidance');
    });
});

describe('buildServerInstructions', () => {
    it('should carry the workflow section and never name the removed list tool', () => {
        const text = buildServerInstructions(INDEX);

        expect(text).toContain(searchWorkflowSection(INDEX));
        expect(text).not.toContain('ui_components_list');
        expect(START_HERE).toContain('ui_components_search');
        expect(START_HERE).not.toContain('ui_components_list');
    });
});
