import { COMPONENT_CATEGORIES, MAX_SUMMARY_LENGTH } from '@punyts/stateui-app/core';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

const COMPOSED_WRITE = defineInput({
    name: { type: 'string', required: true, description: 'The component name (ui_list kind "components"); nodes use it as their "component". A new name creates the component' },
    expectedRevision: { type: 'integer', minimum: 1, description: 'The revision you last read. Leave it out to create the component; when it has changed since, nothing is written' },
    tree: { type: 'object', description: 'The default node tree, with a "component" at its root. Required to create; kept when left out' },
    exposes: {
        type: 'list',
        maxItems: 100,
        description: 'The paths of the tree a user of the component may set or link, each with a description. Kept when left out',
        items: {
            path: { type: 'string', required: true, description: 'A path in the tree, such as "children.title._text"' },
            description: { type: 'string', required: true, description: 'What the path is for, in a phrase' }
        }
    },
    summary: { type: 'string', description: `For the component search: one line, at most ${MAX_SUMMARY_LENGTH} characters. Kept when left out; "" removes it` },
    category: { type: 'string', description: `For the component search: one of ${COMPONENT_CATEGORIES.join(', ')}. Kept when left out; "" removes it` },
    purposes: { type: 'json', description: 'For the component search: 3 to 8 one-line phrases of at most 60 characters, the needs it meets ("show a product price"). Kept when left out; [] removes them' }
});

/** `ui_composed_write`, when the server has parts */
export function createComposedTools(useCases: Pick<UiBuilderUseCases, 'writeComposed'>): readonly UiToolDefinition[] {
    const { writeComposed } = useCases;
    if (writeComposed === undefined) return [];
    return [
        {
            name: 'ui_composed_write',
            description: `Build time: write an owner component, a node tree that apps use by name like a library component, with the paths it exposes. Give summary, category and purposes so the component search finds it by need; without them it is found by name only (searchable: false). The search fields are stored beside the tree, not in it, and a write that leaves one out keeps it. The tree is checked as a composed component (one that contains itself is SUI-NODE-CYCLE); a name the library has is refused (invalid-name), since the library reserves its component names. Leave expectedRevision out to create the component. Returns { name, revision, created, searchable, appWarnings }: appWarnings lists the apps the write breaks.`,
            inputSchema: COMPOSED_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = COMPOSED_WRITE.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { name, expectedRevision, tree, exposes, summary, category, purposes } = parsed.value;
                const result = await writeComposed.execute({
                    name,
                    ...(expectedRevision !== undefined && { expectedRevision }),
                    ...(tree !== undefined && { tree: tree as JsonObject }),
                    ...(exposes !== undefined && { exposes }),
                    ...(summary !== undefined && { summary }),
                    ...(category !== undefined && { category }),
                    ...(purposes !== undefined && { purposes: purposes as readonly string[] })
                });
                switch (result.kind) {
                    case 'written':
                        return succeed({
                            name,
                            revision: result.revision,
                            created: result.created,
                            searchable: result.searchable,
                            ...(!result.searchable && { note: 'found by name only: give summary, category and purposes to make it searchable' }),
                            appWarnings: result.appWarnings,
                            ...(result.moreApps > 0 && { moreApps: result.moreApps })
                        });
                    case 'invalid-argument':
                        return fail('invalid-argument', result.reason, { argument: result.argument, ...(result.argument === 'category' && { allowed: COMPONENT_CATEGORIES }) });
                    case 'invalid-name':
                        return fail('invalid-name', result.reason, { argument: 'name' });
                    case 'duplicate-name':
                        return fail('duplicate-name', `A component named "${name}" already exists; read it with ui_get and pass expectedRevision to change it`, { argument: 'name' });
                    case 'not-found':
                        return fail('not-found', `No component named "${name}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; leave expectedRevision out to create it'}`, {
                            argument: 'name',
                            nearest: result.nearest
                        });
                    case 'conflict':
                        return fail('conflict', `The component is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_get; nothing was written`, {
                            currentRevision: result.currentRevision
                        });
                    case 'invalid':
                        return fail('invalid-component', 'The component has blocking errors; nothing was written. Each error names its path', { errors: result.errors });
                }
            }
        }
    ];
}
