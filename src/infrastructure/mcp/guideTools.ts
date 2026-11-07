import { GUIDE_TOPIC_NAMES, GUIDE_TOPICS } from './guide.js';
import type { GuideContext } from './guide.js';
import { buildServerInstructions } from './instructions.js';
import { READ_ONLY, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

/**
 * The topic that answers the whole server instructions. It is the one answer longer than a topic's cap: it is the
 * instructions, not a topic of its own, and every rule in it is written once, in its topic of the table
 */
export const GUIDE_FALLBACK_TOPIC = 'start';

const GUIDE = defineInput({
    topic: { type: 'string', description: 'The topic to read, such as "logic"; leave it out for the index of topics with when to read each' }
});

/**
 * The guide tool: one topic of how-to guidance by name, or the index of topics. It reads nothing from storage and
 * changes nothing; the texts are made once from the catalog the server was built with, so a topic always gives the
 * same text for one server build. The topic start answers the whole server instructions (the always-on topics and
 * the pointer lines), the fallback for a client that does not show them; its own table text is their build steps 1 to 5
 */
export function createGuideTools(context: GuideContext): readonly UiToolDefinition[] {
    const texts = new Map(GUIDE_TOPICS.map((topic) => [topic.name, topic.name === GUIDE_FALLBACK_TOPIC ? buildServerInstructions(context.index, context.presets) : topic.text(context)]));
    const index = GUIDE_TOPICS.map((topic) => ({ name: topic.name, when: topic.when }));
    return [
        {
            name: 'ui_guide',
            description: `Guide: read one topic of how-to guidance before the step it names. { topic } answers { topic, text }; no topic answers the index { topics: [{ name, when }] }. Topics: ${GUIDE_TOPIC_NAMES.join(', ')}.`,
            inputSchema: GUIDE.schema,
            annotations: READ_ONLY,
            run: (args) => {
                const parsed = GUIDE.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { topic } = parsed.value;
                if (topic === undefined) return succeed({ topics: index });
                const text = texts.get(topic);
                if (text === undefined) return fail('unknown-topic', `No guide topic named "${topic}"; use one of: ${GUIDE_TOPIC_NAMES.join(', ')}`, { topic, topics: GUIDE_TOPIC_NAMES });
                return succeed({ topic, text });
            }
        }
    ];
}
