import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { MissingPart, TreeChoice } from '../../application/partAppCheck.js';
import type { CreatePartApp, CreatePartAppResult } from '../../application/use-cases/CreateApp.js';
import type { ScreenEntry } from '../../application/use-cases/ConfigureApp.js';
import type { CreateScreenResult } from '../../application/use-cases/CreateScreen.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { PART_KIND_WORDS } from '../../domain/partReferences.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { WRITES, defineInput, fail, succeed, withGuides } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

/** What the descriptions of the app and screen tools teach about `uses` */
export const USES_TEXT =
    'uses: { themes: ["theme-name", ...] (the first is the default; a person can switch between them), data: { name: { dataset: "dataset-name" } or { model: "model-name", scope: "persona" } } (each $.data.name the app reads, bound to an owner dataset, or a dataset of that model each person gets their own copy of), logic: { "module-name": { params: { ... } } } (owner logic modules, each with values for the params it declares; every data name a module needs must be bound under data), external: { alias: { app: "<app id>", path: "$.data.notes" } } (another app the logic reads: the state the person has in that app, under path, shown read only at $.external.alias; the logic runs on its changes, and nothing of it is stored), or external: { alias: { owner: "<workspace id>", dataset: "dataset-name" } } (a dataset another owner shared with this workspace: its records, a record map, read only at $.external.alias while the share holds; only datasets the server says were shared can be read) }';

/** What the descriptions teach about a node tree or a pattern */
const TREE_TEXT =
    'a node tree ({ component, ...properties, children }) or { pattern, params? }: a library or owner screen pattern from ui_patterns_search, copied once with the params you give (each one left out takes its default) as ordinary nodes';

/** The app node's properties `ui_app_create` takes */
export const APP_ARGUMENT = {
    type: 'object',
    description:
        "The app node's own properties, all optional: layout (how the app places its screens; one shows at a time, so the default needs none), toasts (the toastRegion node; $.app.toasts is the target of show commands from every screen) and on (app events such as sync.rejected). Its component is app and its _title the title"
} as const;

export const HOME_ARGUMENT = {
    type: 'object',
    description: `The root of the first screen, home: ${TREE_TEXT}. An app is its screens, with no frame around them: a screen pattern such as side-navigation or top-navigation brings a header and a menu, and a header or menu shared by several screens is placed in each (ui_composed_write makes it one composed component). A bare panel when left out`
} as const;

/** The `ui_app_create` arguments of an app of parts, beside `name` */
export const PART_APP_FIELDS = {
    title: { type: 'string', description: 'The title' },
    themes: { type: 'json', schema: { type: 'array', items: { type: 'string' } }, description: 'uses.themes, a list of owner theme names; the first is the default' },
    data: {
        type: 'object',
        description: 'uses.data, each $.data name bound to { dataset: "dataset-name" } or { model: "model-name", scope: "persona" }'
    },
    logic: { type: 'object', description: 'uses.logic, each owner logic module by name with { params: { ... } }' },
    app: APP_ARGUMENT,
    home: HOME_ARGUMENT,
    icons: {
        type: 'object',
        description:
            'Icons the app carries of its own, for glyphs the icon set does not have, so home may name them from the start: each { outline: [paths], filled?: [paths] }, a path the d of an SVG <path> in a 24×24 view box. ui_icons_write changes them later'
    }
} as const;

const CONFIGURE = defineInput({
    name: { type: 'string', required: true, description: 'The app name from ui_list (kind "apps")' },
    expectedRevision: { type: 'integer', minimum: 1, required: true, description: 'The app revision you last read; when it has changed since, nothing changes' },
    title: { type: 'string', description: 'The new title' },
    uses: { type: 'object', description: 'The new uses, whole: it replaces the old one and is checked with every binding and module together' },
    start: { type: 'string', description: 'The screen the app opens on; it must be one of the app\'s screens' },
    ephemeral: {
        type: 'json',
        schema: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        description: 'The state paths, whole list, whose changes reach everyone using the app but are never stored and never hold up a save, such as a pointer or presence ("$.data.presence.*", * for any one segment); [] for none'
    },
    screens: {
        type: 'json',
        schema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, title: { type: 'string' } }, required: ['name'] }, maxItems: 200 },
        description: 'Every screen once, in the new order, as { name, title? }; a title retitles that screen ("" removes it)'
    }
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

/** A screen root argument (`home`) as the use case takes it, or the error for one that is neither a pattern nor a node */
export function treeChoice(value: JsonObject, argument: string): TreeChoice | ToolOutcome {
    if (Object.hasOwn(value, 'pattern')) {
        const { pattern, params } = value;
        if (typeof pattern !== 'string') return fail('invalid-argument', `${argument}.pattern must be a pattern name`, { argument: `${argument}.pattern` });
        if (params !== undefined && !isJsonObject(params)) return fail('invalid-argument', `${argument}.params must be an object`, { argument: `${argument}.params` });
        return { pattern, ...(params !== undefined && { params }) };
    }
    if (typeof value['component'] !== 'string') {
        return fail('invalid-argument', `${argument} must be a node tree with a "component" or { pattern, params? }`, { argument });
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

/** Said when a link points under `$.data` at nothing: what to bind or create first */
const DATA_LINK_HINT =
    ' A link to $.data.<name>... needs <name> bound in uses.data (ui_app_create data, or ui_app_configure) to a dataset that holds the record the path names: create or bind it first, or give the pattern another path param.';

function invalidApp(errors: readonly UiBuildError[], what: string): ToolOutcome {
    const dataLink = errors.some((error) => error.code === 'SUI-LINK-MISSING' && error.message.includes('$.data.'));
    return fail('invalid-app', `The app would have blocking errors; nothing was ${what}. Each error names its part and path.${dataLink ? DATA_LINK_HINT : ''}`, { errors });
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
        case 'unknown-pattern': {
            const near = result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; ui_patterns_search finds one';
            return fail('invalid-argument', `No such pattern: "${result.pattern}"${near}. Or give a node tree; nothing was ${what}`, {
                argument,
                nearest: result.nearest
            });
        }
        case 'pattern-params': {
            const params = argument === 'home' ? 'home.params' : 'patternParams';
            return fail('invalid-argument', `${result.problems.map((problem) => problem.message).join('; ')}; nothing was ${what}`, {
                argument: params,
                params: result.problems.map((problem) => problem.param)
            });
        }
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
    readonly app?: JsonObject;
    readonly home?: JsonObject;
    readonly icons?: JsonObject;
}

/** `ui_app_create`: an app of parts */
export async function runPartAppCreate(createPartApp: CreatePartApp, args: PartAppCreateArguments): Promise<ToolOutcome> {
    const { themes } = args;
    if (themes !== undefined && (!Array.isArray(themes) || !themes.every((theme) => typeof theme === 'string'))) {
        return fail('invalid-argument', 'themes must be a list of theme names', { argument: 'themes' });
    }
    if (args.app !== undefined && Object.hasOwn(args.app, 'component') && args.app['component'] !== 'app') {
        return fail('invalid-argument', "app holds the app node's properties; its component is always 'app'", { argument: 'app.component' });
    }
    const home = args.home === undefined ? undefined : treeChoice(args.home, 'home');
    if (home !== undefined && 'isError' in home) return home;
    const result = await createPartApp.execute({
        name: args.name,
        ...(home !== undefined && { home }),
        ...(args.app !== undefined && { app: args.app }),
        ...(args.title !== undefined && { title: args.title }),
        ...(themes !== undefined && { themes: themes as string[] }),
        ...(args.data !== undefined && { data: args.data }),
        ...(args.logic !== undefined && { logic: args.logic }),
        ...(args.icons !== undefined && { icons: args.icons })
    });
    if (result.kind === 'created') {
        return succeed({ name: result.name, id: result.id, revision: result.revision, start: 'home', slots: result.slots, warnings: withGuides(result.warnings) });
    }
    return sharedOutcome(result, 'home', 'created');
}

function isScreenEntry(value: unknown): value is ScreenEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry['name'] === 'string' && (entry['title'] === undefined || typeof entry['title'] === 'string');
}

/** `ui_app_configure` and `ui_screen_create`, when the server has parts */
export function createPartAppTools(useCases: Pick<UiBuilderUseCases, 'configureApp' | 'createScreen'>): readonly UiToolDefinition[] {
    const { configureApp, createScreen } = useCases;
    if (configureApp === undefined || createScreen === undefined) return [];
    return [
        {
            name: 'ui_app_configure',
            description: `Build time: change an app's title, uses, start screen, ephemeral paths, or the order and titles of its screens (state shared but never stored, such as a pointer); every other field stays as it is. ${USES_TEXT}. A new uses replaces the old one whole and is checked with every binding and module together: a part that does not exist comes back with the nearest names, an error (such as a module need left unbound) with its part. Returns { name, revision, warnings }.`,
            inputSchema: CONFIGURE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = CONFIGURE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { name, expectedRevision, title, uses, start, ephemeral, screens } = parsed.value;
                if (ephemeral !== undefined && (!Array.isArray(ephemeral) || !ephemeral.every((item) => typeof item === 'string'))) {
                    return fail('invalid-argument', 'ephemeral is a list of state paths', { argument: 'ephemeral' });
                }
                if (screens !== undefined && (!Array.isArray(screens) || !screens.every(isScreenEntry))) {
                    return fail('invalid-argument', 'screens is a list of { name, title? }', { argument: 'screens' });
                }
                const result = await configureApp.execute({
                    ...(ephemeral !== undefined && { ephemeral: ephemeral as string[] }),
                    ...(screens !== undefined && { screens: screens as ScreenEntry[] }),
                    name,
                    expectedRevision,
                    ...(title !== undefined && { title }),
                    ...(uses !== undefined && { uses }),
                    ...(start !== undefined && { start })
                });
                switch (result.kind) {
                    case 'configured':
                        return succeed({ name, revision: result.revision, warnings: withGuides(result.warnings) });
                    case 'nothing-to-change':
                        return fail('invalid-argument', 'Give title, uses, start, ephemeral or screens', { argument: 'title' });
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
                'Build time: add a screen to an app: a title, typed params and a root, either a node tree (root) or a library screen pattern from ui_patterns_search (pattern, with patternParams for its params; each one left out takes its default), copied once as ordinary nodes. The screen is the whole view while the app shows it (the app\'s layout places it), so it places its own header and menu: a navigate command names the screen as its target and passes the params as its value. Adding a screen writes the app: expectedRevision is the app\'s, and the result has the app\'s new revision. The app is checked as a whole first. Returns { app, name, revision, slots, warnings }: slots are the places of the pattern to fill, each { name, path, description } with the node path for ui_nodes_write (none for a root).',
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
                if (result.kind === 'created') return succeed({ app, name, revision: result.revision, slots: result.slots, warnings: withGuides(result.warnings) });
                return sharedOutcome(result, pattern !== undefined ? 'pattern' : 'root', 'created');
            }
        }
    ];
}
