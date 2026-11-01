import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { DEFAULT_ICON_LIST_LIMIT, MAX_ICON_LIST_LIMIT } from '../../application/use-cases/ListIcons.js';
import { READ_ONLY, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

const COMPONENTS_LIST = defineInput({
    query: { type: 'string', description: 'Words that must each appear in the component name or summary' },
    tier: { type: 'string', enum: ['root', 'composed'], description: 'root: components that draw themselves; composed: ready-made trees of other components' }
});

const COMPONENT_GET = defineInput({
    name: { type: 'string', required: true, description: 'The component name from ui_components_list, such as "button"' }
});

const ICONS_LIST = defineInput({
    query: { type: 'string', description: 'Words that must each match an icon name, alias or tag' },
    category: { type: 'string', description: 'Only icons of this category' },
    filled: { type: 'boolean', description: 'true: only icons that have a filled variant' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_ICON_LIST_LIMIT, description: `How many icons to return (default ${DEFAULT_ICON_LIST_LIMIT})` }
});

const TOKENS_LIST = defineInput({
    group: { type: 'string', description: 'Only tokens of this top-level group, such as "color", "space", "radius" or "motion"; an unknown group answers with the groups that exist' },
    query: { type: 'string', description: 'Words that must each appear in the token path or description' },
    includeOverlays: { type: 'boolean', description: 'true: also list the shipped theme overlays by kind with the token groups each kind may touch' }
});

/** The catalog tools: discover the components, icons and theme tokens an application can use */
export function createCatalogTools(
    useCases: Pick<UiBuilderUseCases, 'listComponents' | 'getComponent' | 'listIcons' | 'listTokens'>
): readonly UiToolDefinition[] {
    return [
        {
            name: 'ui_components_list',
            description:
                'List the components an application can use, one line each: name, tier, size and summary. Filter with query words or tier. Call ui_component_get for the full shape of one component.',
            inputSchema: COMPONENTS_LIST.schema,
            annotations: READ_ONLY,
            run: (args) => {
                const parsed = COMPONENTS_LIST.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const components = useCases.listComponents.execute({
                    ...(parsed.value.query !== undefined && { query: parsed.value.query }),
                    ...(parsed.value.tier !== undefined && { tier: parsed.value.tier })
                });
                return succeed({ count: components.length, components });
            }
        },
        {
            name: 'ui_component_get',
            description:
                'Get the full catalog entry of one component: shape (properties and defaults), slots, events, commands, an example node and the languages it ships. An unknown name returns the nearest names.',
            inputSchema: COMPONENT_GET.schema,
            annotations: READ_ONLY,
            run: (args) => {
                const parsed = COMPONENT_GET.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const result = useCases.getComponent.execute(parsed.value.name);
                if (result.kind === 'found') return succeed(result.component);
                return fail('unknown-component', `No component named "${result.name}"`, { name: result.name, nearest: result.nearest });
            }
        },
        {
            name: 'ui_icons_list',
            description:
                'Search the icon set by words, tag or category. Returns icon names with category, tags and whether a filled variant exists, best matches first, and how many more matched. Icon names in an application must come from this list.',
            inputSchema: ICONS_LIST.schema,
            annotations: READ_ONLY,
            run: (args) => {
                const parsed = ICONS_LIST.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const result = useCases.listIcons.execute({
                    ...(parsed.value.query !== undefined && { query: parsed.value.query }),
                    ...(parsed.value.category !== undefined && { category: parsed.value.category }),
                    ...(parsed.value.filled !== undefined && { filled: parsed.value.filled }),
                    ...(parsed.value.limit !== undefined && { limit: parsed.value.limit })
                });
                return succeed(result);
            }
        },
        {
            name: 'ui_tokens_list',
            description:
                'List the theme tokens a "theme" override may set, with type, default value and a one-line description, filtered by group or words, and optionally the shipped theme overlays by kind (mode, brand, motion). Token names for theme overrides and overlay names for theme switches come from this tool; component token names come from ui_component_get. Values are checked when the document is written.',
            inputSchema: TOKENS_LIST.schema,
            annotations: READ_ONLY,
            run: (args) => {
                const parsed = TOKENS_LIST.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const result = useCases.listTokens.execute({
                    ...(parsed.value.group !== undefined && { group: parsed.value.group }),
                    ...(parsed.value.query !== undefined && { query: parsed.value.query }),
                    ...(parsed.value.includeOverlays !== undefined && { includeOverlays: parsed.value.includeOverlays })
                });
                if (result.kind === 'unknown-group') {
                    return fail('unknown-group', `No token group named "${result.group}"; the groups are ${result.groups.join(', ')}`, {
                        group: result.group,
                        groups: result.groups
                    });
                }
                return succeed({
                    count: result.tokens.length,
                    tokens: result.tokens,
                    ...(result.overlays !== undefined && { overlays: result.overlays })
                });
            }
        }
    ];
}
