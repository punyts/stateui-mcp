import { MAX_SUMMARY_LENGTH } from '@punyts/stateui-app/core';
import { SHELL_SOURCE } from '../../application/use-cases/WritePattern.js';
import type { PatternSource } from '../../application/use-cases/WritePattern.js';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

const PATTERN_WRITE = defineInput({
    name: { type: 'string', required: true, description: 'The pattern name (ui_list kind "patterns"); ui_app_create and ui_screen_create take it as pattern. A new name creates the pattern' },
    expectedRevision: { type: 'integer', minimum: 1, description: 'The revision you last read. Leave it out to create the pattern; when it has changed since, nothing is written' },
    kind: { type: 'string', enum: ['shell', 'screen'], description: 'shell (a frame with exactly one outlet) or screen (no outlet). Required to create; kept when left out' },
    summary: { type: 'string', description: `One line, at most ${MAX_SUMMARY_LENGTH} characters: what the pattern is. Required to create; kept when left out` },
    purposes: { type: 'json', description: '3 to 8 one-line phrases of at most 60 characters, the needs it meets ("book a table for tonight"). Required to create; kept when left out' },
    tree: { type: 'object', description: 'The node tree, with a "component" at its root. Give it or from; kept when both are left out' },
    from: {
        type: 'object',
        description: `Copy the tree once from an owner app: { app, screen }, where screen is a screen name or "${SHELL_SOURCE}" for the app's shell. Give it or tree`
    },
    slots: {
        type: 'object',
        description: 'The places an agent fills, by name: { path, description }, path a node path of the tree ("children.form.children"). Kept when left out; none on a create'
    },
    params: {
        type: 'object',
        description:
            'The values a create may set, by name: { type, default?, required?, paths, description }, type string, number, boolean or path (a state path such as "$.data.products"), paths the tree paths the value is written to. Kept when left out; none on a create'
    }
});

/** `{ app, screen }` of the `from` argument, or the problem with it */
function sourceOf(from: JsonObject): PatternSource | string {
    const { app, screen } = from;
    if (typeof app !== 'string' || app === '') return 'from.app must be the name of an owner app';
    if (typeof screen !== 'string' || screen === '') return `from.screen must be a screen name or "${SHELL_SOURCE}"`;
    const extra = Object.keys(from).filter((key) => key !== 'app' && key !== 'screen');
    if (extra.length > 0) return `from takes app and screen only, not ${extra.join(', ')}`;
    return { app, screen };
}

/** `ui_pattern_write`, when the server has parts */
export function createPatternTools(useCases: Pick<UiBuilderUseCases, 'writePattern'>): readonly UiToolDefinition[] {
    const { writePattern } = useCases;
    if (writePattern === undefined) return [];
    return [
        {
            name: 'ui_pattern_write',
            description: `Build time: write an owner pattern, a shell or screen that ui_app_create (shell: { pattern }) and ui_screen_create (pattern) start from, in the format of the library's patterns. Give the tree, or copy it once from an owner app with from: { app, screen } (screen "${SHELL_SOURCE}" for the app's shell), then name its slots and params as paths of that tree. It is checked as the library checks its patterns: every node, every slot and param path, and exactly one outlet in a shell and none in a screen; a failure writes nothing and names its path. A name of a library pattern is refused (invalid-name). Leave expectedRevision out to create the pattern. Returns { name, revision, created }.`,
            inputSchema: PATTERN_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = PATTERN_WRITE.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { name, expectedRevision, kind, summary, purposes, tree, from, slots, params } = parsed.value;
                let source: PatternSource | undefined;
                if (from !== undefined) {
                    const read = sourceOf(from as JsonObject);
                    if (typeof read === 'string') return fail('invalid-argument', read, { argument: 'from' });
                    source = read;
                }
                const result = await writePattern.execute({
                    name,
                    ...(expectedRevision !== undefined && { expectedRevision }),
                    ...(kind !== undefined && { kind }),
                    ...(summary !== undefined && { summary }),
                    ...(purposes !== undefined && { purposes: purposes as readonly string[] }),
                    ...(tree !== undefined && { tree: tree as JsonObject }),
                    ...(source !== undefined && { from: source }),
                    ...(slots !== undefined && { slots: slots as JsonObject }),
                    ...(params !== undefined && { params: params as JsonObject })
                });
                switch (result.kind) {
                    case 'written':
                        return succeed({ name, revision: result.revision, created: result.created });
                    case 'invalid-argument':
                        return fail('invalid-argument', result.reason, { argument: result.argument });
                    case 'source-not-found':
                        return fail('not-found', `${result.reason}${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : ''}`, { argument: result.argument, nearest: result.nearest });
                    case 'invalid-name':
                        return fail('invalid-name', result.reason, { argument: 'name' });
                    case 'duplicate-name':
                        return fail('duplicate-name', `A pattern named "${name}" already exists; read it with ui_get and pass expectedRevision to change it`, { argument: 'name' });
                    case 'not-found':
                        return fail('not-found', `No pattern named "${name}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; leave expectedRevision out to create it'}`, {
                            argument: 'name',
                            nearest: result.nearest
                        });
                    case 'conflict':
                        return fail('conflict', `The pattern is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_get; nothing was written`, {
                            currentRevision: result.currentRevision
                        });
                    case 'invalid':
                        return fail('invalid-pattern', 'The pattern has blocking errors; nothing was written. Each error names its path in the pattern file', { errors: result.errors });
                }
            }
        }
    ];
}
