import { describe, expect, it } from 'vitest';
import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';
import { EXPECTED_TOOLS } from '../../../test/expectedTools.js';
import { buildServerInstructions, graphicsSection, searchWorkflowSection, START_HERE } from './instructions.js';

/** The tool names of each step, in the order the steps list them */
const STEP_TOOLS = [
    'ui_theme_create',
    'ui_theme_write',
    'ui_tokens_list',
    'ui_model_write',
    'ui_data_write',
    'ui_patterns_search',
    'ui_app_create',
    'ui_screen_create',
    'ui_components_search',
    'ui_component_get',
    'ui_nodes_write',
    'ui_logic_write',
    'ui_validate',
    'ui_preview',
    'ui_screenshot',
    'ui_interact'
];
const PRESETS = Object.freeze(['calm', 'bold', 'warm', 'crisp']);

function toolNames(text: string): string[] {
    return [...new Set(text.match(/\bui_[a-z_]+/g) ?? [])];
}

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

    it('should list the eight steps, plan first, with their tools in step order', () => {
        // Act
        const text = searchWorkflowSection(INDEX);

        // Assert
        const steps = ['1. Plan', '2. Theme', '3. Data', '4. App and shell', '5. Screens', '6. Sections', '7. Logic', '8. Check'].map((step) => text.indexOf(step));
        expect(steps.every((at) => at >= 0)).toBe(true);
        expect(steps).toEqual([...steps].sort((left, right) => left - right));
        const firsts = STEP_TOOLS.map((name) => text.indexOf(name));
        expect(firsts.every((at) => at > steps[0]!)).toBe(true);
        expect(firsts).toEqual([...firsts].sort((left, right) => left - right));
    });

    it('should call the order guidance, start an edit at its step, and show the plan of a large app', () => {
        // Act
        const text = searchWorkflowSection(INDEX);

        // Assert
        expect(text).toContain('The order is guidance');
        expect(text).toContain('an edit starts at the step the change needs');
        expect(text).toContain('more than three screens, or one that writes to an owner dataset other apps use');
        expect(text).toContain('wait for their OK');
    });

    it('should check at full page and at phone width', () => {
        // Act
        const text = searchWorkflowSection(INDEX);

        // Assert
        expect(text).toContain('fullPage: true');
        expect(text).toContain('width: 375');
    });

    it('should name the four presets of a catalog that has them', () => {
        // Act
        const text = searchWorkflowSection(INDEX, PRESETS);

        // Assert
        expect(text).toContain('Theme presets for ui_theme_create (preset): calm, bold, warm, crisp.');
    });

    it('should leave out the preset line, but keep both theme tools, while the catalog has no presets', () => {
        // Act
        const text = searchWorkflowSection(INDEX, []);

        // Assert
        expect(text).not.toMatch(/preset/i);
        expect(text).toContain('ui_theme_create');
        expect(text).toContain('ui_theme_write');
    });
});

describe('graphicsSection', () => {
    it('should name every 2D shape and say shapes sit in a drawing', () => {
        // Act
        const text = graphicsSection();

        // Assert
        for (const shape of ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'drawText', 'drawImage', 'drawGroup', 'drawRepeat']) expect(text).toContain(shape);
        expect(text).toContain('holds shape nodes in its children');
        expect(text).toContain('accepted only inside a drawing');
    });

    it('should state the value, record colour and drag rules', () => {
        // Act
        const text = graphicsSection();

        // Assert
        expect(text).toContain('a literal, a theme token');
        expect(text).toContain('a link ("<-cx"');
        expect(text).toContain('A colour that depends on a record comes from the record');
        expect(text).toContain('"<-fill": "$row.fill"');
        expect(text).toContain('once, on release');
    });

    it('should say shapes are reached with ui_tree rendered and ui_interact, in about ten lines', () => {
        // Act
        const text = graphicsSection();

        // Assert
        expect(text).toContain('ui_tree with rendered: true lists its interactive shapes');
        expect(text).toContain('ui_interact takes click, press, hover, focus and key');
        expect(text.split('\n').length).toBeLessThanOrEqual(12);
        expect(toolNames(text).filter((name) => !EXPECTED_TOOLS.includes(name))).toEqual([]);
    });

    it('should be a section of the server instructions', () => {
        expect(buildServerInstructions(INDEX, PRESETS)).toContain(graphicsSection());
    });
});

describe('buildServerInstructions', () => {
    it('should carry the workflow section and never name the removed list tool', () => {
        const text = buildServerInstructions(INDEX, PRESETS);

        expect(text).toContain(searchWorkflowSection(INDEX, PRESETS));
        expect(text).not.toContain('ui_components_list');
        expect(START_HERE).toContain('ui_components_search');
        expect(START_HERE).not.toContain('ui_components_list');
    });

    it('should name only registered tools and none of the removed ones', () => {
        // Act
        const text = `${buildServerInstructions(INDEX, PRESETS)}
${START_HERE}`;

        // Assert
        expect(toolNames(text).filter((name) => !EXPECTED_TOOLS.includes(name))).toEqual([]);
        for (const removed of ['ui_app_write', 'ui_components_list', 'ui_outline']) expect(text).not.toContain(removed);
    });
});
