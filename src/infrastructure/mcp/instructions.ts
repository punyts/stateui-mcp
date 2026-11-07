/**
 * What the model is told about this server. The MCP server is the only place it sees this guidance, so the working
 * loop and the rules that cost a failed call live here (in the server `instructions`, built from the guide's topics in
 * `guide.ts`) and, for the two tools a build starts with, in their descriptions
 */

import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';
import { GUIDE_TOPICS, guideText } from './guide.js';
import type { GuideContext, GuideTopic } from './guide.js';

/** The opening line of the instructions, before the topics */
const OPENING = 'StateUI app builder. Apps are declarative documents; you build them with tools and check them in a real browser.';

/**
 * Topics that continue the section of the topic before them, so the instructions join the two with one line break
 * instead of a blank line. A section longer than one topic was split at a line, not a paragraph: the build steps after
 * step 5 and the 3D lines after the camera and after repeat3d
 */
const CONTINUES = new Set(['sections', 'scene3d-models', 'scene3d-behavior']);

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

/** What the instructions say for one topic: its text when it is always on, else one line pointing to it */
function topicSection(topic: GuideTopic, context: GuideContext): string {
    return topic.alwaysOn ? topic.text(context) : `Before ${topic.when}, read ui_guide topic ${topic.name}.`;
}

/**
 * The `instructions` field of the server, shown by the client to the model, built from the guide's topics with the
 * catalog's category index and presets: the opening line, then each topic in table order
 */
export function buildServerInstructions(index: readonly CategoryIndexEntry[], presets: readonly string[] = [], topics: readonly GuideTopic[] = GUIDE_TOPICS): string {
    const context = contextOf(index, presets);
    let text = OPENING;
    for (const topic of topics) text += `${CONTINUES.has(topic.name) ? '\n' : '\n\n'}${topicSection(topic, context)}`;
    return text;
}

/** Appended to the descriptions of the tools a build starts with, so the loop is in front of the model at the first call */
export const START_HERE = 'Start of the working loop: ui_list, ui_theme_create, ui_model_write, ui_patterns_search, ui_app_create, ui_screen_create, ui_components_search, ui_nodes_write, ui_validate, ui_preview (see the build steps in the server instructions). Icon names come from ui_icons_list, keys must not be integer-like ("o42", not "42"), and a set through a missing parent fails (add the parent first or use merge).';
