import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { ThemeOperation, ThemeReport } from '../../application/use-cases/WriteTheme.js';
import { MAX_OPERATIONS_PER_WRITE } from '../../domain/limits.js';
import { CREATES, WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { ParsedArguments, ToolOutcome, UiToolDefinition } from './toolKit.js';
import type { ThemePresetSummary } from '../../application/ports/PatternCatalog.js';

/** The input of ui_theme_create: `preset` is an enum of the library's presets, each described, when there are any */
function themeCreateInput(presets: readonly ThemePresetSummary[]) {
    const names = presets.map((preset) => preset.name);
    const described = presets.map((preset) => (preset.summary === '' ? preset.name : `${preset.name} (${preset.summary})`)).join('; ');
    return defineInput({
        name: { type: 'string', required: true, description: 'The new theme\'s name: lower-case letters, digits and dashes, starting with a letter' },
        from: { type: 'string', description: 'A theme of yours to copy (ui_list kind "themes"), with all its tokens and overlays' },
        preset: {
            type: 'string',
            ...(names.length > 0 && { enum: names }),
            description: names.length > 0 ? `A library preset to start from: ${described}` : 'A library preset to start from; this library has none'
        }
    });
}

const THEME_ITEMS = {
    op: {
        type: 'string',
        required: true,
        enum: ['set', 'remove', 'add-overlay', 'remove-overlay'],
        description: 'set writes a token, remove takes one out (the default value applies again), add-overlay creates an empty overlay of a kind, remove-overlay deletes one with its tokens'
    },
    path: { type: 'string', description: 'set and remove: a token path from ui_tokens_list, such as "color.accent.base", or a component token from ui_component_get, such as "image.fill"' },
    value: { type: 'json', description: 'set only: the value, such as "#204080" or "{palette.blue.600}" for a reference to another token' },
    overlay: { type: 'string', description: 'set and remove: the overlay to write in, else the base tokens. add-overlay and remove-overlay: the overlay name' },
    kind: { type: 'string', enum: ['mode', 'brand', 'motion'], description: 'add-overlay only: mode may set color and elevation, brand palette, font.family, radius and icon, motion motion' }
} as const;

const THEME_WRITE = defineInput({
    theme: { type: 'string', required: true, description: 'The theme name from ui_list (kind "themes")' },
    expectedRevision: { type: 'integer', minimum: 1, description: 'The theme revision you last read; when it has changed since, nothing is written. Leave it out to create the theme, starting with no tokens' },
    operations: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: `The changes, applied in order as one checked write (at most ${MAX_OPERATIONS_PER_WRITE})`,
        items: THEME_ITEMS
    }
});

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

function misplaced(index: number, name: string, message: string): ToolOutcome {
    return fail('invalid-argument', `operations[${index}].${name} ${message}`, { argument: `operations[${index}].${name}` });
}

type ThemeItem = ParsedArguments<typeof THEME_ITEMS>;

/** One parsed item as a theme operation, or the argument error for a field the operation lacks or does not take */
function toOperation(item: ThemeItem, index: number): ThemeOperation | ToolOutcome {
    const forbid = (names: readonly (keyof ThemeItem)[]): ToolOutcome | undefined => {
        const extra = names.find((name) => item[name] !== undefined);
        return extra === undefined ? undefined : misplaced(index, extra, `is not allowed for ${item.op}`);
    };
    const need = (name: keyof ThemeItem): ToolOutcome | undefined => (item[name] === undefined ? misplaced(index, name, `is required for ${item.op}`) : undefined);
    const overlay = item.overlay === undefined ? {} : { overlay: item.overlay };
    switch (item.op) {
        case 'set':
            return need('path') ?? need('value') ?? forbid(['kind']) ?? { op: 'set', path: item.path!, value: item.value!, ...overlay };
        case 'remove':
            return need('path') ?? forbid(['value', 'kind']) ?? { op: 'remove', path: item.path!, ...overlay };
        case 'add-overlay':
            return need('overlay') ?? need('kind') ?? forbid(['path', 'value']) ?? { op: 'add-overlay', overlay: item.overlay!, kind: item.kind! };
        default:
            return need('overlay') ?? forbid(['path', 'value', 'kind']) ?? { op: 'remove-overlay', overlay: item.overlay! };
    }
}

function reportBody(name: string, report: ThemeReport): Record<string, unknown> {
    return {
        theme: name,
        revision: report.revision,
        warnings: report.warnings,
        ...(report.moreApps > 0 && { moreApps: report.moreApps }),
        contrast: report.contrast,
        reaches: report.reaches
    };
}

const REPORT_TEXT =
    'contrast: the WCAG ratio of each text token on its surface in each mode ({ mode, text, surface, ratio, passesAA }, AA being 4.5; ratio "unresolved" when a side is not an opaque colour); reaches: for each written token, the components whose own tokens (ui_component_get) refer to it, directly or through a semantic token; a token component styles read directly, such as color.text.base, lists none; warnings: the apps that use the theme and now have errors, by name';

/** `ui_theme_create` and `ui_theme_write`, when the server has parts */
export function createThemeTools(useCases: Pick<UiBuilderUseCases, 'createTheme' | 'writeTheme'>, presets: readonly ThemePresetSummary[] = []): readonly UiToolDefinition[] {
    const { createTheme, writeTheme } = useCases;
    if (createTheme === undefined || writeTheme === undefined) return [];
    const THEME_CREATE = themeCreateInput(presets);
    const presetNames = presets.map((preset) => preset.name);
    return [
        {
            name: 'ui_theme_create',
            description: `Build time: create a theme as a copy of one of yours (from) or of a library preset (preset); give exactly one. The copy has its own id and starts at revision 1; change it with ui_theme_write, and an app uses it by naming it in its themes. Returns { theme, revision, warnings, contrast, reaches }. ${REPORT_TEXT}.`,
            inputSchema: THEME_CREATE.schema,
            annotations: CREATES,
            run: async (args) => {
                const parsed = THEME_CREATE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { name, from, preset } = parsed.value;
                if ((from === undefined) === (preset === undefined)) return fail('invalid-argument', 'Give exactly one of from and preset', { argument: from === undefined ? 'from' : 'preset' });
                const result = await createTheme.execute(from !== undefined ? { name, from } : { name, preset: preset! });
                switch (result.kind) {
                    case 'created':
                        return succeed(reportBody(name, result));
                    case 'invalid-name':
                        return fail('invalid-name', result.reason, { argument: 'name' });
                    case 'duplicate-name':
                        return fail('duplicate-name', `A theme named "${name}" already exists; pick another name or change it with ui_theme_write`, { argument: 'name' });
                    case 'not-found':
                        return fail('not-found', `No theme named "${from}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; ui_list lists the themes'}`, {
                            argument: 'from',
                            nearest: result.nearest
                        });
                    case 'unknown-preset':
                        return fail('invalid-argument', `No such preset: "${result.preset}"; ${presetNames.length > 0 ? `use one of: ${presetNames.join(', ')}` : 'this library has none'}`, {
                            argument: 'preset',
                            allowed: presetNames
                        });
                    case 'invalid':
                        return fail('invalid-theme', 'The theme has blocking errors; nothing was written', { errors: result.errors });
                }
            }
        },
        {
            name: 'ui_theme_write',
            description: `Build time: change a theme token by token, with up to ${MAX_OPERATIONS_PER_WRITE} operations applied in order: set or remove a token at the base or in one overlay (overlay), add an overlay with its kind or remove one. Token names come from ui_tokens_list and component token names from ui_component_get; never guess one. Each overlay kind may touch only its groups (mode: color, elevation; brand: palette, font.family, radius, icon; motion: motion). The theme is checked on its own and written as one change, or not at all; then every app that uses it is checked. Pass expectedRevision; leave it out to create a theme from no tokens (ui_theme_create copies one instead). Returns { theme, revision, created, warnings, contrast, reaches }. ${REPORT_TEXT}.`,
            inputSchema: THEME_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = THEME_WRITE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { theme, expectedRevision } = parsed.value;
                const operations: ThemeOperation[] = [];
                for (const [index, item] of parsed.value.operations.entries()) {
                    const converted = toOperation(item, index);
                    if (!('op' in converted)) return converted;
                    operations.push(converted);
                }
                const result = await writeTheme.execute({ theme, ...(expectedRevision !== undefined && { expectedRevision }), operations });
                switch (result.kind) {
                    case 'written':
                        return succeed({ ...reportBody(theme, result), created: result.created });
                    case 'invalid-name':
                        return fail('invalid-name', result.reason, { argument: 'theme' });
                    case 'not-found':
                        return fail('not-found', `No theme named "${theme}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; leave expectedRevision out to create it'}`, {
                            argument: 'theme',
                            nearest: result.nearest
                        });
                    case 'conflict':
                        return fail('conflict', `The theme is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_get; nothing was written`, {
                            currentRevision: result.currentRevision
                        });
                    case 'invalid-operation':
                        return fail('invalid-operation', `Operation ${result.index} could not be applied: ${result.error.message}`, { index: result.index, errors: [result.error] });
                    case 'invalid':
                        return fail('invalid-theme', 'The theme would have blocking errors; nothing was written. Each error names its path', { errors: result.errors });
                }
            }
        }
    ];
}
