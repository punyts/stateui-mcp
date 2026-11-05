import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { MissingPart, TreeChoice } from '../../application/partAppCheck.js';
import type { CreatePartApp, CreatePartAppResult } from '../../application/use-cases/CreateApp.js';
import type { CreateScreenResult } from '../../application/use-cases/CreateScreen.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { PART_KIND_WORDS } from '../../domain/partReferences.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

/** What the descriptions of the app and screen tools teach about `uses` */
export const USES_TEXT =
    'uses: { themes: ["theme-name", ...] (the first is the default; a person can switch between them), data: { name: { dataset: "dataset-name" } or { model: "model-name", scope: "persona" } } (each $.data.name the app reads, bound to an owner dataset, or a dataset of that model each person gets their own copy of), logic: { "module-name": { params: { ... } } } (owner logic modules, each with values for the params it declares; every data name a module needs must be bound under data) }';

/** What the descriptions teach about a node tree or a pattern */
const TREE_TEXT = 'a node tree ({ component, ...properties, children }) or { pattern, params? } naming a library pattern';

export const SHELL_ARGUMENT = {
    type: 'object',
    description: `The frame around every screen (header, navigation, footer): ${TREE_TEXT}. A node tree needs exactly one { component: "outlet" } node, where the current screen shows`
} as const;

/** The `ui_app_create` arguments of an app of parts, beside `name` */
export const PART_APP_FIELDS = {
    title: { type: 'string', description: 'The title' },
    themes: { type: 'json', description: 'uses.themes, a list of owner theme names; the first is the default' },
    data: {
        type: 'object',
        description: 'uses.data, each $.data name bound to { dataset: "dataset-name" } or { model: "model-name", scope: "persona" }'
    },
    logic: { type: 'object', description: 'uses.logic, each owner logic module by name with { params: { ... } }' },
    shell: SHELL_ARGUMENT
} as const;

const CONFIGURE = defineInput({
    name: { type: 'string', required: true, description: 'The app name from ui_list (kind "apps")' },
    expectedRevision: { type: 'integer', minimum: 1, required: true, description: 'The app revision you last read; when it has changed since, nothing changes' },
    title: { type: 'string', description: 'The new title' },
    uses: { type: 'object', description: 'The new uses, whole: it replaces the old one and is checked with every binding and module together' },
    start: { type: 'string', description: 'The screen the app opens on; it must be one of the app\'s screens' }
});

const SCREEN = defineInput({
    app: { type: 'string', required: true, description: 'The app name from ui_list (kind "apps")' },
    name: { type: 'string', required: true, description: 'The screen name: lower-case letters, digits and dashes, starting with a letter; unique in the app' },
    expectedRevision: { type: 'integer', minimum: 1, required: true, description: 'The app revision you last read: adding a screen writes the app and raises its revision' },
    title: { type: 'string', description: 'The screen title' },
    params: {
        type: 'object',
        description: 'Typed params by name, such as { "id": { "type": "string", "required": true } }; a navigate command to the screen passes them as its value'
    },
    pattern: { type: 'string', description: 'A library screen pattern to start from. Give pattern or root' },
    patternParams: { type: 'object', description: 'With pattern: the values of the pattern\'s params' },
    root: { type: 'object', description: 'The screen\'s root node tree ({ component, ...properties, children }). Give pattern or root' }
});

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

/** A shell argument as the use case takes it, or the error for one that is neither a pattern nor a node */
export function shellChoice(value: JsonObject): TreeChoice | ToolOutcome {
    if (Object.hasOwn(value, 'pattern')) {
        const { pattern, params } = value;
        if (typeof pattern !== 'string') return fail('invalid-argument', 'shell.pattern must be a pattern name', { argument: 'shell.pattern' });
        if (params !== undefined && !isJsonObject(params)) return fail('invalid-argument', 'shell.params must be an object', { argument: 'shell.params' });
        return { pattern, ...(params !== undefined && { params }) };
    }
    if (typeof value['component'] !== 'string') {
        return fail('invalid-argument', 'shell must be a node tree with a "component" or { pattern, params? }', { argument: 'shell' });
    }
    return { node: value };
}

function missingParts(missing: readonly MissingPart[], what: string): ToolOutcome {
    const lines = missing.map((part) => {
        const near = part.nearest.length > 0 ? ` (nearest: ${part.nearest.join(', ')})` : '';
        return `no ${PART_KIND_WORDS[part.kind]} "${part.name}"${near}`;
    });
    return fail('not-found', `The app names parts the owner does not have: ${lines.join('; ')}. Create them first, or use a name ui_list lists; nothing was ${what}`, {
        missing
    });
}

function invalidApp(errors: readonly UiBuildError[], what: string): ToolOutcome {
    return fail('invalid-app', `The app would have blocking errors; nothing was ${what}. Each error names its part and path`, { errors });
}

/** The outcomes `ui_app_create` and `ui_screen_create` share */
function sharedOutcome(result: Exclude<CreatePartAppResult | CreateScreenResult, { kind: 'created' }>, argument: string, what: string): ToolOutcome {
    switch (result.kind) {
        case 'missing-parts':
            return missingParts(result.missing, what);
        case 'invalid':
            return invalidApp(result.errors, what);
        case 'invalid-name':
            return fail('invalid-name', `${result.reason}; nothing was ${what}`, { argument: 'name' });
        case 'duplicate-name':
            return fail('duplicate-name', `The name is taken; nothing was ${what}`, { argument: 'name' });
        case 'unknown-pattern':
            return fail('invalid-argument', `No such pattern: "${result.pattern}". Give a node tree instead`, { argument });
        case 'wrong-pattern-kind':
            return fail('invalid-argument', `"${result.pattern}" is a ${result.patternKind} pattern`, { argument });
        case 'pattern-params':
            return fail('invalid-argument', `Pattern params are not applied yet; give "${result.pattern}" without params`, { argument });
        case 'not-found':
            return fail('not-found', `No app with this name${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; ui_list lists the apps'}`, {
                argument: 'app',
                nearest: result.nearest
            });
        case 'conflict':
            return fail('conflict', `The app is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_get; nothing was ${what}`, {
                currentRevision: result.currentRevision
            });
    }
}

export interface PartAppCreateArguments {
    readonly name: string;
    readonly title?: string;
    readonly themes?: unknown;
    readonly data?: JsonObject;
    readonly logic?: JsonObject;
    readonly shell: JsonObject;
}

/** `ui_app_create` with `shell`: an app of parts */
export async function runPartAppCreate(createPartApp: CreatePartApp, args: PartAppCreateArguments): Promise<ToolOutcome> {
    const { themes } = args;
    if (themes !== undefined && (!Array.isArray(themes) || !themes.every((theme) => typeof theme === 'string'))) {
        return fail('invalid-argument', 'themes must be a list of theme names', { argument: 'themes' });
    }
    const shell = shellChoice(args.shell);
    if ('isError' in shell) return shell;
    const result = await createPartApp.execute({
        name: args.name,
        shell,
        ...(args.title !== undefined && { title: args.title }),
        ...(themes !== undefined && { themes: themes as string[] }),
        ...(args.data !== undefined && { data: args.data }),
        ...(args.logic !== undefined && { logic: args.logic })
    });
    if (result.kind === 'created') return succeed({ name: result.name, id: result.id, revision: result.revision, start: 'home', warnings: result.warnings });
    return sharedOutcome(result, 'shell', 'created');
}

/** `ui_app_configure` and `ui_screen_create`, when the server has parts */
export function createPartAppTools(useCases: Pick<UiBuilderUseCases, 'configureApp' | 'createScreen'>): readonly UiToolDefinition[] {
    const { configureApp, createScreen } = useCases;
    if (configureApp === undefined || createScreen === undefined) return [];
    return [
        {
            name: 'ui_app_configure',
            description: `Build time: change an app's title, uses or start screen; every other field stays as it is. ${USES_TEXT}. A new uses replaces the old one whole and is checked with every binding and module together: a part that does not exist comes back with the nearest names, an error (such as a module need left unbound) with its part. Returns { name, revision, warnings }.`,
            inputSchema: CONFIGURE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = CONFIGURE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { name, expectedRevision, title, uses, start } = parsed.value;
                const result = await configureApp.execute({
                    name,
                    expectedRevision,
                    ...(title !== undefined && { title }),
                    ...(uses !== undefined && { uses }),
                    ...(start !== undefined && { start })
                });
                switch (result.kind) {
                    case 'configured':
                        return succeed({ name, revision: result.revision, warnings: result.warnings });
                    case 'nothing-to-change':
                        return fail('invalid-argument', 'Give title, uses or start', { argument: 'title' });
                    case 'not-found':
                        return sharedOutcome(result, 'name', 'changed');
                    case 'conflict':
                    case 'missing-parts':
                    case 'invalid':
                        return sharedOutcome(result, 'uses', 'changed');
                }
            }
        },
        {
            name: 'ui_screen_create',
            description:
                'Build time: add a screen to an app: a title, typed params and a root, either a node tree (root) or a library screen pattern (pattern with patternParams). The screen shows in the shell\'s outlet when the app navigates to it: a navigate command names the screen as its target and passes the params as its value. Adding a screen writes the app: expectedRevision is the app\'s, and the result has the app\'s new revision. The app is checked as a whole first. Returns { app, name, revision, warnings }.',
            inputSchema: SCREEN.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = SCREEN.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { app, name, expectedRevision, title, params, pattern, patternParams, root } = parsed.value;
                if ((pattern === undefined) === (root === undefined)) {
                    return fail('invalid-argument', 'Give pattern or root, not both', { argument: pattern === undefined ? 'root' : 'pattern' });
                }
                if (patternParams !== undefined && pattern === undefined) return fail('invalid-argument', 'patternParams go with pattern', { argument: 'patternParams' });
                if (root !== undefined && typeof root['component'] !== 'string') {
                    return fail('invalid-argument', 'root must be a node tree with a "component"', { argument: 'root' });
                }
                const choice: TreeChoice =
                    root !== undefined ? { node: root } : { pattern: pattern as string, ...(patternParams !== undefined && { params: patternParams }) };
                const result = await createScreen.execute({
                    app,
                    name,
                    expectedRevision,
                    root: choice,
                    ...(title !== undefined && { title }),
                    ...(params !== undefined && { params })
                });
                if (result.kind === 'created') return succeed({ app, name, revision: result.revision, warnings: result.warnings });
                return sharedOutcome(result, pattern !== undefined ? 'pattern' : 'root', 'created');
            }
        }
    ];
}
