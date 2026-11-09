import { describe, expect, it } from 'vitest';
import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';
import { EXPECTED_TOOLS } from '../../../test/expectedTools.js';
import { GUIDE_TOPICS, guideTopic } from './guide.js';
import { buildServerInstructions, GUIDE_INTRO, graphicsSection, paintFieldSection, pointerLine, scene3dSection, searchWorkflowSection, START_HERE } from './instructions.js';

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
        const steps = ['1. Plan', '2. Theme', '3. Data', '4. App', '5. Screens', '6. Sections', '7. Logic', '8. Check'].map((step) => text.indexOf(step));
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

    it('should be a pointer line of the server instructions, not its text (K1.2 of the guide-tool epic)', () => {
        // Act
        const text = buildServerInstructions(INDEX, PRESETS);

        // Assert
        expect(text).not.toContain(graphicsSection());
        expect(text).toContain('Before a drawing and its shapes, read ui_guide topic drawing.');
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

    it('should be a pointer line of the server instructions, after the drawing one', () => {
        // Act
        const text = buildServerInstructions(INDEX, PRESETS);

        // Assert
        expect(text).not.toContain(paintFieldSection());
        expect(text.indexOf('read ui_guide topic paint-field.')).toBeGreaterThan(text.indexOf('read ui_guide topic drawing.'));
    });
});

describe('scene3dSection', () => {
    it('should name scene3d and the 3D nodes of releases 3A and 3B (repeat3d of G3.6, label3d of G3.6b)', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('scene3d node (category graphics)');
        for (const node of ['camera', 'light', 'mesh', 'model', 'label3d', 'group3d', 'repeat3d']) expect(text).toContain(node);
    });

    it('should say an interactive 3D node raises press and hover and the agent tools act on its path (G3.8)', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('interactive: true on a 3D node (with a _label) makes it pressable');
        expect(text).toContain('press (a click, not a drag that turns the camera) and hover (once each time the pointer enters)');
        expect(text).toContain('repeat3d copy with $row at its record');
        expect(text).toContain('ui_tree with rendered: true lists those nodes (...rows.<recordKey> for a copy)');
        expect(text).toContain('ui_interact clicks, hovers, focuses and presses keys on their paths; drag turns the camera of a scene with controls');
    });

    it('should say a scene3d needs _title and _fallback', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('Give every scene3d a _title');
        expect(text).toContain('and a _fallback');
    });

    it('should say models are uploaded GLB files under 10 MiB, referenced as files, and that map is an image file (G3.7c)', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('model.src is the file reference { id, name, size, type } of a GLB (model/gltf-binary');
        expect(text).toContain('at most 10 MiB');
        expect(text).toContain('a person uploaded');
        expect(text).toContain('a .gltf, a Draco, Meshopt or KTX2 compressed model');
        expect(text).not.toContain('material.map is not drawn yet');
        expect(text).toContain('a material ({ color, metalness, roughness, opacity, emissive, map })');
        expect(text).toContain('material.map is the file reference of an uploaded png, jpeg, gif or webp image, wrapped around the mesh and tinted by its color');
        expect(text).toContain('another type is SUI-STATE-INVALID, and a file that cannot be read is SUI-RUN-FILE with the colour drawn');
    });

    it('should say controls write the camera once on release, warn past 16 scenes, and that the screenshot waits', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('writes the active camera node\'s position and target once, when the gesture is released');
        expect(text).toContain('at most 16 WebGL contexts');
        expect(text).toContain('ui_validate warns past 16 scenes');
        expect(text).toContain('ui_screenshot of its path: it waits until the scene, its models and textures are drawn and its transitions have arrived');
        expect(text).toContain('a playing animate or clip does not hold it back');
    });

    it('should say transition eases the 3D channels and jumps with reduced motion (G3.9)', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('A node with transition ({ duration, easing } as for 2D shapes) eases position, rotation, scale, material color and opacity');
        expect(text).toContain('a light\'s intensity and a camera\'s position and target when state changes them');
        expect(text).toContain('with reduced motion it jumps');
    });

    it('should say label3d draws plain text in the page font facing the camera, its fontSize and default colour (G3.6b)', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('label3d draws its _text (plain text, linkable) in the page font, always facing the camera');
        expect(text).toContain('fontSize is in scene units (0.3 by default) and color defaults to the theme text colour');
        expect(text).toContain('An empty _text draws nothing');
    });

    it('should say animate and model clips play without writing state, the unknown clip error and reduced motion (G3.9b)', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('animate ({ name: spin, bob or pulse, duration, loop, delay }) plays on a node');
        expect(text).toContain('a model plays its GLB clip named by animation while playing is true');
        expect(text).toContain('neither writes state, an unknown clip is SUI-RUN-3D naming the file\'s clips, and with reduced motion neither plays');
    });

    it('should say repeat3d draws one instanced mesh from records, what varies per record and its cap (G3.6)', () => {
        // Act
        const text = scene3dSection();

        // Assert
        expect(text).toContain('repeat3d draws its row (one mesh) once per record of records');
        expect(text).toContain('"<-position": "$row.at"');
        expect(text).toContain('Each record has its own position, rotation, scale, visible and material.color');
        expect(text).toContain('SUI-RUN-DRAW');
        expect(text).toContain('At most 20,000 records (more are cut, SUI-RUN-CAP)');
    });

    it('should be a header and one bullet per topic, in the order a scene is built (G3.11, second pass)', () => {
        // Arrange
        const starts = ['3D: a scene3d node', '- Give every scene3d', '- position, target, rotation', '- With no camera node', '- model.src', '- material.map', '- repeat3d', '- interactive: true', '- label3d', '- A node with transition', '- Check a scene'];

        // Act
        const lines = scene3dSection().split('\n');

        // Assert
        expect(lines).toHaveLength(starts.length);
        lines.forEach((line, index) => expect(line.startsWith(starts[index] ?? '\0'), line).toBe(true));
    });

    it('should take about ten lines and name only registered tools', () => {
        // Act
        const text = scene3dSection();

        // Assert: 11, one more than the first pass's cap of 10, so each topic of releases 3A and 3B has a line of its
        // own instead of two topics merged into one (the 16-contexts warning with the screenshot, models with textures);
        // the drawing section takes 12 for the same "about ten lines"
        expect(text.split('\n').length).toBeLessThanOrEqual(11);
        expect(toolNames(text).filter((name) => !EXPECTED_TOOLS.includes(name))).toEqual([]);
    });

    it('should be three pointer lines of the server instructions, after the painting one', () => {
        // Act
        const text = buildServerInstructions(INDEX, PRESETS);

        // Assert
        expect(text).not.toContain(scene3dSection().split('\n')[0]);
        const at = ['paint-field', 'scene3d', 'scene3d-models', 'scene3d-behavior'].map((name) => text.indexOf(`read ui_guide topic ${name}.`));
        expect(at.every((position) => position >= 0)).toBe(true);
        expect(at).toEqual([...at].sort((left, right) => left - right));
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

    it('should introduce ui_guide in the second paragraph, right after the opening line (K1.2 of the guide-tool epic)', () => {
        // Act
        const [opening, second] = buildServerInstructions(INDEX, PRESETS).split('\n\n');

        // Assert
        expect(opening).toMatch(/^StateUI app builder\./);
        expect(second).toBe(GUIDE_INTRO);
        expect(second).toMatch(/^ui_guide is the guide/);
        expect(second).toContain('its description lists the topics');
        expect(second).toContain('Read a topic before the step it names');
    });

    it('should give the build steps, the index, the presets and the rules that cost a failed call in full', () => {
        // Act
        const text = buildServerInstructions(INDEX, PRESETS);

        // Assert
        expect(text).toContain(searchWorkflowSection(INDEX, PRESETS));
        expect(text).toContain('Icon names come from ui_icons_list. Never guess an icon name.');
        expect(text).toContain('Token names for "theme" overrides');
        expect(text).toContain('must not be integer-like: use "o42", not "42"');
        expect(text).toContain('A set through a missing parent fails.');
    });

    it('should give every other topic one pointer line, in table order, as one block at the end', () => {
        // Arrange
        const pointed = GUIDE_TOPICS.filter((topic) => !topic.alwaysOn);

        // Act
        const text = buildServerInstructions(INDEX, PRESETS);

        // Assert
        expect(pointed.map((topic) => topic.name)).toEqual(['parts', 'paths', 'revisions', 'modules', 'logic', 'tables', 'live-view', 'files', 'drawing', 'paint-field', 'scene3d', 'scene3d-models', 'scene3d-behavior', 'safety']);
        expect(text.endsWith(`\n\n${pointed.map(pointerLine).join('\n')}`)).toBe(true);
        expect(pointerLine(guideTopic('logic')!)).toBe('Before a machine or rule, read ui_guide topic logic.');
        for (const topic of pointed) expect(text).not.toContain(topic.text({ index: INDEX, presets: PRESETS }));
    });

    it('should leave out the pointer block when every topic is always on', () => {
        // Act
        const text = buildServerInstructions(INDEX, PRESETS, GUIDE_TOPICS.map((topic) => ({ ...topic, alwaysOn: true })));

        // Assert
        expect(text).not.toContain('read ui_guide topic');
        for (const topic of GUIDE_TOPICS) expect(text).toContain(topic.text({ index: INDEX, presets: PRESETS }));
    });
});

describe('START_HERE', () => {
    it('should name ui_guide once', () => {
        expect(START_HERE.match(/\bui_guide\b/g)).toHaveLength(1);
        expect(START_HERE).toContain('ui_guide topic start');
    });
});
