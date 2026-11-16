/**
 * What the model is told about this server. The MCP server is the only place it sees this guidance, so the working
 * loop and the rules that cost a failed call live here (in the server `instructions`, built from the guide's always-on
 * topics in `guide.ts`) and, for the tools a build starts with, in their descriptions. Every other topic gets one
 * pointer line, and the agent reads it with ui_guide before the step it names
 */

import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';
import { GUIDE_TOPICS, guideText } from './guide.js';
import type { GuideContext, GuideTopic } from './guide.js';

/** The opening line of the instructions, before the topics */
const OPENING = 'StateUI app builder. Apps are declarative documents; you build them with tools and check them in a real browser.';

/** The second paragraph of the instructions: what ui_guide is and when to read a topic (K1.2 of the guide-tool epic) */
export const GUIDE_INTRO = 'ui_guide is the guide to these tools: it answers one topic of how-to guidance by name, and its description lists the topics. This text holds the build steps and the rules that cost a failed call; the rest is in topics. Read a topic before the step it names: the lines at the end say which. You already have this text, so do not read the topic start: it only repeats this text for a client that does not show it.';

/**
 * Always-on topics that continue the section of the topic before them, so the instructions join the two with one line
 * break instead of a blank line: the build steps were split after step 5
 */
const CONTINUES = new Set(['sections']);

function contextOf(index: readonly CategoryIndexEntry[], presets: readonly string[]): GuideContext {
    return { index, presets };
}

/**
 * The eight build steps, from the plan to the check, with the generated category index and the theme presets: the
 * guide topics start and sections. `presets` are the library's theme preset names; with none the preset sentence is
 * left out, so the text never names a preset that is not there
 */
export function searchWorkflowSection(index: readonly CategoryIndexEntry[], presets: readonly string[] = []): string {
    const context = contextOf(index, presets);
    return `${guideText('start', context)}\n${guideText('sections', context)}`;
}

const NO_CATALOG = contextOf([], []);

/** The shape vocabulary of drawings and its rules (G1.10 of the graphics epic 1): the guide topic drawing */
export function graphicsSection(): string {
    return guideText('drawing', NO_CATALOG);
}

/** The painting field (G2.11 of the graphics epic 2): the guide topic paint-field */
export function paintFieldSection(): string {
    return guideText('paint-field', NO_CATALOG);
}

/**
 * 3D scenes (graphics epic 3, releases 3A and 3B; written by G3.11 in two passes): a header line, then one bullet per
 * subject in the order an agent builds a scene. The guide topics scene3d, scene3d-models and scene3d-behavior, joined
 */
export function scene3dSection(): string {
    return ['scene3d', 'scene3d-models', 'scene3d-behavior'].map((name) => guideText(name, NO_CATALOG)).join('\n');
}

/** The line the instructions give a topic that is not always on */
export function pointerLine(topic: Pick<GuideTopic, 'name' | 'when'>): string {
    return `Before ${topic.when}, read ui_guide topic ${topic.name}.`;
}

/**
 * The `instructions` field of the server, shown by the client to the model, built from the guide's topics with the
 * catalog's category index and presets: the opening line, the paragraph on ui_guide, the always-on topics in full in
 * table order, then one pointer line for each other topic, in table order, as one block at the end. The guide topic
 * start answers the same text
 */
export function buildServerInstructions(index: readonly CategoryIndexEntry[], presets: readonly string[] = [], topics: readonly GuideTopic[] = GUIDE_TOPICS): string {
    const context = contextOf(index, presets);
    let text = `${OPENING}\n\n${GUIDE_INTRO}`;
    for (const topic of topics.filter((entry) => entry.alwaysOn)) text += `${CONTINUES.has(topic.name) ? '\n' : '\n\n'}${topic.text(context)}`;
    const pointers = topics.filter((entry) => !entry.alwaysOn).map(pointerLine);
    return pointers.length > 0 ? `${text}\n\n${pointers.join('\n')}` : text;
}

/** Appended to the descriptions of the tools a build starts with, so the loop is in front of the model at the first call */
export const START_HERE = 'Start of the working loop: ui_list, ui_theme_create, ui_model_write, ui_patterns_search, ui_app_create, ui_screen_create, ui_components_search, ui_nodes_write, ui_validate, ui_preview (see the build steps in the server instructions, or ui_guide topic start when they are not shown). Icon names come from ui_icons_list, keys must not be integer-like ("o42", not "42"), and a set through a missing parent fails (add the parent first or use merge).';
