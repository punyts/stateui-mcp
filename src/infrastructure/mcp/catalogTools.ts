import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { DEFAULT_ICON_LIST_LIMIT, MAX_ICON_LIST_LIMIT } from '../../application/use-cases/ListIcons.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../StateUiComponentCatalog.js';
import { READ_ONLY, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

const COMPONENTS_SEARCH = defineInput({
    need: { type: 'string', required: true, allowEmpty: true, description: 'What the component is for, in plain words, such as "pick a date range" or "show totals by month"' },
    category: { type: 'string', description: 'Only components of this category (the index in the server instructions lists them)' },
    tier: { type: 'string', description: 'Only components of this tier: root (draws itself) or composed (a ready-made tree of other components)' },
    limit: { type: 'integer', minimum: 1, description: `How many results (default ${DEFAULT_SEARCH_LIMIT}, at most ${MAX_SEARCH_LIMIT})` }
});

const PATTERNS_SEARCH = defineInput({
    need: { type: 'string', required: true, description: 'What the shell or screen is for, in plain words, such as "online store product page" or "sign in"' },
    kind: { type: 'string', description: 'Only patterns of this kind: shell (the frame around every screen, with the outlet) or screen' },
    limit: { type: 'integer', minimum: 1, description: `How many results (default ${DEFAULT_SEARCH_LIMIT}, at most ${MAX_SEARCH_LIMIT})` }
});

const COMPONENT_GET = defineInput({
    name: { type: 'string', required: true, description: 'The component name from ui_components_search, such as "button"' }
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
    useCases: Pick<UiBuilderUseCases, 'searchComponents' | 'searchPatterns' | 'getComponent' | 'listIcons' | 'listTokens'>
): readonly UiToolDefinition[] {
    return [
        {
            name: 'ui_components_search',
            description:
                'Find the components for a need, described in plain words ("pick a date range", "step through checkout"), library and owner (ui_composed_write) components, best first: name, category, tier, source (library or owner), summary, the purpose phrases that matched and an example node. Search once per part of your plan; ui_component_get gives the full shape of the one you choose. The result is never empty: weak: true means nothing fitted well, and a need that matches nothing returns the category index and the components of the nearest category.',
            inputSchema: COMPONENTS_SEARCH.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = COMPONENTS_SEARCH.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { need, category, tier, limit } = parsed.value;
                const outcome = await useCases.searchComponents.execute({
                    need,
                    ...(category !== undefined && { category }),
                    ...(tier !== undefined && { tier }),
                    ...(limit !== undefined && { limit })
                });
                if (outcome.kind === 'invalid-argument') {
                    return fail('invalid-argument', `Unknown ${outcome.argument}; use one of: ${outcome.allowed.join(', ')}`, { argument: outcome.argument, allowed: outcome.allowed });
                }
                return succeed(outcome.result);
            }
        },
        {
            name: 'ui_patterns_search',
            description:
                'Find a ready shell or screen for a need, described in plain words ("online store product page", "sign in"), library and owner (ui_pattern_write) patterns, best first: name, kind, source (library or owner), summary, the purpose phrases that matched, its slots (where your content goes), its params (a title and the dataset paths, with defaults) and the components it uses. Start an app or a screen from the one that fits, then fill its slots. The result is never empty: weak: true means nothing fitted well, and a need that matches nothing lists the patterns of the kind (of both kinds when no kind is given).',
            inputSchema: PATTERNS_SEARCH.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = PATTERNS_SEARCH.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { need, kind, limit } = parsed.value;
                if (need.trim() === '') return fail('invalid-argument', 'need must say what the shell or screen is for', { argument: 'need' });
                const outcome = await useCases.searchPatterns.execute({ need, ...(kind !== undefined && { kind }), ...(limit !== undefined && { limit }) });
                if (outcome.kind === 'invalid-argument') {
                    return fail('invalid-argument', `Unknown ${outcome.argument}; use one of: ${outcome.allowed.join(', ')}`, { argument: outcome.argument, allowed: outcome.allowed });
                }
                return succeed(outcome.result);
            }
        },
        {
            name: 'ui_component_get',
            description:
                'Get what you need to use one component: its properties (type, and default, allowed values, validators and required only where they apply; runtime: true marks a value the component sets while the app runs, kind: "content" a translatable text), shared and layout settings, slots, events, commands, tokens (the component tokens its look reads, with type and default, such as image.fill; set them in a node "theme" to change that node and its subtree), an example node and the languages it ships. A composed component gives its tree and the paths it exposes instead of properties. An unknown name returns the nearest names.',
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
