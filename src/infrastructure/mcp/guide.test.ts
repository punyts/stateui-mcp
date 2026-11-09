import { describe, expect, it } from 'vitest';
import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';
import { EXPECTED_TOOLS } from '../../../test/expectedTools.js';
import { GUIDE_TOPIC_NAMES, GUIDE_TOPICS, MAX_TOPIC_CHARS, guideText, guideTopic } from './guide.js';
import type { GuideContext, GuideTopic } from './guide.js';
import { createGuideTools, GUIDE_FALLBACK_TOPIC } from './guideTools.js';
import { buildServerInstructions, graphicsSection, paintFieldSection, scene3dSection } from './instructions.js';

/** A catalog the size of the library's: ten categories with long member names, and the four presets */
const CATALOG: GuideContext = Object.freeze({
    index: Object.freeze(
        ['layout', 'forms', 'data', 'navigation', 'feedback', 'media', 'overlays', 'text', 'graphics', 'commerce'].map(
            (category): CategoryIndexEntry => Object.freeze({ category, count: 24, typical: Object.freeze(['dateRangeField', 'navigationRail', 'segmentedControl']) })
        )
    ),
    presets: Object.freeze(['calm', 'bold', 'warm', 'crisp'])
});

const NO_CATALOG: GuideContext = Object.freeze({ index: [], presets: [] });

function toolNames(text: string): string[] {
    return [...new Set(text.match(/\bui_[a-z_]+/g) ?? [])];
}

function guideTool(context: GuideContext = CATALOG) {
    const [tool] = createGuideTools(context);
    if (tool === undefined) throw new Error('no guide tool');
    return tool;
}

describe('the guide topics', () => {
    it('should start with the first topics of the guide-tool epic and one topic per graphics section', () => {
        // Assert
        for (const name of ['start', 'paths', 'revisions', 'keys', 'logic', 'live-view', 'files', 'safety', 'drawing', 'paint-field', 'scene3d']) {
            expect(GUIDE_TOPIC_NAMES, name).toContain(name);
        }
        expect(GUIDE_TOPIC_NAMES[0]).toBe('start');
        expect(new Set(GUIDE_TOPIC_NAMES).size).toBe(GUIDE_TOPICS.length);
    });

    it.each(GUIDE_TOPICS.map((topic) => [topic.name, topic] as const))('should keep %s under the cap with a when line, with and without a catalog', (_name, topic) => {
        // Act
        const texts = [topic.text(CATALOG), topic.text(NO_CATALOG)];

        // Assert
        for (const text of texts) {
            expect(text.length).toBeGreaterThan(0);
            expect(text.length).toBeLessThan(MAX_TOPIC_CHARS);
            expect(toolNames(text).filter((name) => !EXPECTED_TOOLS.includes(name))).toEqual([]);
        }
        expect(topic.when.trim().length).toBeGreaterThan(0);
        expect(topic.when.startsWith('before')).toBe(false);
        expect(topic.name).toMatch(/^[a-z][a-z0-9-]*$/);
    });

    it('should give the same text for the same topic and catalog', () => {
        for (const topic of GUIDE_TOPICS) expect(topic.text(CATALOG)).toBe(topic.text(CATALOG));
    });

    it('should put the presets and the category index in the sections topic', () => {
        // Act
        const text = guideText('sections', CATALOG);

        // Assert
        expect(text).toContain('Theme presets for ui_theme_create (preset): calm, bold, warm, crisp.');
        expect(text).toContain('- commerce (24): dateRangeField, navigationRail, segmentedControl');
        expect(guideText('start', CATALOG)).toContain('or from a preset');
        expect(guideText('start', NO_CATALOG)).not.toMatch(/preset/i);
    });

    it('should find a topic by name and nothing for another name', () => {
        expect(guideTopic('logic')?.name).toBe('logic');
        expect(guideTopic('nothing')).toBeUndefined();
        expect(() => guideText('nothing', NO_CATALOG)).toThrow('No guide topic named "nothing"');
    });

    it('should be the graphics sections of the instructions', () => {
        expect(graphicsSection()).toBe(guideText('drawing', NO_CATALOG));
        expect(paintFieldSection()).toBe(guideText('paint-field', NO_CATALOG));
        expect(scene3dSection()).toBe(['scene3d', 'scene3d-models', 'scene3d-behavior'].map((name) => guideText(name, NO_CATALOG)).join('\n'));
    });
});

describe('buildServerInstructions from the topics', () => {
    it('should keep only the build steps and the rules that cost a failed call always on (K1.2 of the guide-tool epic)', () => {
        expect(GUIDE_TOPICS.filter((topic) => topic.alwaysOn).map((topic) => topic.name)).toEqual(['start', 'sections', 'keys']);
    });

    it('should give every always-on topic in full, in table order', () => {
        // Act
        const text = buildServerInstructions(CATALOG.index, CATALOG.presets);

        // Assert
        const at = GUIDE_TOPICS.filter((topic) => topic.alwaysOn).map((topic) => text.indexOf(topic.text(CATALOG)));
        expect(at.every((position) => position >= 0)).toBe(true);
        expect(at).toEqual([...at].sort((left, right) => left - right));
    });

    it('should give a topic that is not always on as one pointer line, and no line for an always-on one', () => {
        // Arrange
        const topics: readonly GuideTopic[] = GUIDE_TOPICS.map((topic) => ({ ...topic, alwaysOn: topic.name !== 'logic' }));

        // Act
        const text = buildServerInstructions(CATALOG.index, CATALOG.presets, topics);

        // Assert
        expect(text).not.toContain(guideText('logic', CATALOG));
        expect(text.endsWith('\n\nBefore a machine or rule, read ui_guide topic logic.')).toBe(true);
        expect(text.match(/read ui_guide topic/g)).toHaveLength(1);
    });

    it('should hold every rule once: each topic is in full or one pointer line, never both', () => {
        // Act
        const text = buildServerInstructions(CATALOG.index, CATALOG.presets);

        // Assert
        for (const topic of GUIDE_TOPICS) {
            const full = text.split(topic.text(CATALOG)).length - 1;
            const pointed = text.split(`read ui_guide topic ${topic.name}.`).length - 1;
            expect([full, pointed], topic.name).toEqual(topic.alwaysOn ? [1, 0] : [0, 1]);
        }
    });
});

describe('ui_guide', () => {
    it('should describe itself as the guide and list every topic name', () => {
        // Act
        const tool = guideTool();

        // Assert
        expect(tool.name).toBe('ui_guide');
        expect(tool.description.startsWith('Guide: ')).toBe(true);
        for (const name of GUIDE_TOPIC_NAMES) expect(tool.description, name).toMatch(new RegExp(`\\s${name}[,;]`));
        // The fallback topic start comes last, marked as a repeat of the server instructions, so agents that have them skip it
        expect(tool.description).toContain('; and start, which only repeats the server instructions for a client that does not show them.');
        expect(tool.annotations.readOnlyHint).toBe(true);
    });

    it('should answer the index of every topic with its when line when no topic is given', async () => {
        // Act
        const outcome = await guideTool().run({});

        // Assert
        expect(outcome.isError).toBe(false);
        expect(outcome.body).toEqual({ topics: GUIDE_TOPICS.map((topic) => ({ name: topic.name, when: topic.when })) });
    });

    it.each(GUIDE_TOPIC_NAMES.filter((name) => name !== GUIDE_FALLBACK_TOPIC).map((name) => [name]))('should answer the %s topic with its text for the catalog of the build', async (name) => {
        // Act
        const outcome = await guideTool().run({ topic: name });

        // Assert
        expect(outcome.isError).toBe(false);
        expect(outcome.body).toEqual({ topic: name, text: guideText(name, CATALOG) });
    });

    it('should answer the start topic with the whole server instructions, for a client that does not show them', async () => {
        // Act
        const outcome = await guideTool().run({ topic: 'start' });

        // Assert
        expect(GUIDE_FALLBACK_TOPIC).toBe('start');
        expect(outcome.isError).toBe(false);
        expect(outcome.body).toEqual({ topic: 'start', text: buildServerInstructions(CATALOG.index, CATALOG.presets) });
        expect((outcome.body as { text: string }).text).toContain(guideText('start', CATALOG));
    });

    it('should fail an unknown topic with unknown-topic and the topic names', async () => {
        // Act
        const outcome = await guideTool().run({ topic: 'drawings' });

        // Assert
        expect(outcome.isError).toBe(true);
        expect(outcome.body).toMatchObject({ error: 'unknown-topic', topic: 'drawings', topics: GUIDE_TOPIC_NAMES });
        expect((outcome.body as { message: string }).message).toContain('No guide topic named "drawings"');
    });

    it('should fail an argument that is not a string or not its own', async () => {
        // Act
        const wrongType = await guideTool().run({ topic: 3 });
        const unknown = await guideTool().run({ name: 'logic' });

        // Assert
        expect(wrongType.body).toMatchObject({ error: 'invalid-argument', argument: 'topic' });
        expect(unknown.body).toMatchObject({ error: 'invalid-argument', argument: 'name' });
    });
});
