import { describe, expect, it } from 'vitest';
import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';
import { EXPECTED_TOOLS } from '../../../test/expectedTools.js';
import { buildServerInstructions, graphicsSection, paintFieldSection, scene3dSection, searchWorkflowSection, START_HERE } from './instructions.js';

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

    it('should say what a drawImage src may be (G1.9b)', () => {
        // Act
        const text = graphicsSection();

        // Assert
        expect(text).toContain('src is a data: URL of a png, jpeg, gif or webp picture, or the reference { id, name, size, type }');
        expect(text).toContain('an SVG is refused');
        expect(text).toContain('SUI-RUN-FILE');
    });

    it('should say draggable needs interactive: true and how ui_interact drags a shape by an offset', () => {
        // Act
        const text = graphicsSection();

        // Assert
        expect(text).toContain('moves a shape that also has interactive: true (without it draggable does nothing)');
        expect(text).toContain('drag value "+dx,+dy" moves it by page pixels');
    });

    it('should say shapes are reached with ui_tree rendered and ui_interact, in about ten lines', () => {
        // Act
        const text = graphicsSection();

        // Assert
        expect(text).toContain('ui_tree with rendered: true lists its interactive shapes');
        expect(text).toContain('ui_interact takes click, press, hover, focus, key and drag');
        expect(text.split('\n').length).toBeLessThanOrEqual(12);
        expect(toolNames(text).filter((name) => !EXPECTED_TOOLS.includes(name))).toEqual([]);
    });

    it('should be a section of the server instructions', () => {
        expect(buildServerInstructions(INDEX, PRESETS)).toContain(graphicsSection());
    });
});

describe('paintFieldSection', () => {
    it('should name paintField, its file value and the typed alternative in two lines', () => {
        // Act
        const text = paintFieldSection();

        // Assert
        expect(text).toContain('paintField (category forms)');
        expect(text).toContain('a PNG');
        expect(text).toContain('{ id, name, size, type }');
        expect(text).toContain('a form waits for the save');
        expect(text).toContain('textField');
        expect(text.split('\n')).toHaveLength(2);
        expect(toolNames(text)).toEqual([]);
    });

    it('should be a section of the server instructions, after the drawing section', () => {
        // Act
        const text = buildServerInstructions(INDEX, PRESETS);

        // Assert
        expect(text).toContain(paintFieldSection());
        expect(text.indexOf(paintFieldSection())).toBeGreaterThan(text.indexOf(graphicsSection()));
    });
});

describe('scene3dSection', () => {
    it('should name scene3d and only the 3D nodes release 3A draws', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('scene3d node (category graphics)');
        for (const node of ['camera', 'light', 'mesh', 'model', 'group3d']) expect(text).toContain(node);
        for (const unbuilt of ['repeat3d', 'label3d', 'transition', 'animate', 'press', 'hover']) expect(text).not.toMatch(new RegExp(`\\b${unbuilt}\\b`));
    });

    it('should say a scene3d needs _title and _fallback', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('Give every scene3d a _title');
        expect(text).toContain('and a _fallback');
    });

    it('should say models are uploaded GLB files under 10 MiB, referenced as files, and that map is not drawn', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('model.src is the file reference { id, name, size, type } of a GLB (model/gltf-binary');
        expect(text).toContain('at most 10 MiB');
        expect(text).toContain('a person uploaded');
        expect(text).toContain('a .gltf, a Draco, Meshopt or KTX2 compressed model');
        expect(text).toContain('material.map is not drawn yet');
    });

    it('should say controls write the camera once on release, warn past 16 scenes, and that the screenshot waits', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('writes the active camera node\'s position and target once, when the gesture is released');
        expect(text).toContain('at most 16 WebGL contexts');
        expect(text).toContain('ui_validate warns past 16 scenes');
        expect(text).toContain('ui_screenshot of its path: it waits until the scene and its models are drawn');
    });

    it('should take about ten lines and name only registered tools', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text.split('\n').length).toBeLessThanOrEqual(10);
        expect(toolNames(text).filter((name) => !EXPECTED_TOOLS.includes(name))).toEqual([]);
    });

    it('should be a section of the server instructions, after the painting section', () => {
        // Act
        const text = buildServerInstructions(INDEX, PRESETS);

        // Assert
        expect(text).toContain(scene3dSection());
        expect(text.indexOf(scene3dSection())).toBeGreaterThan(text.indexOf(paintFieldSection()));
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
