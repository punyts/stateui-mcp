import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { formatRenderedTree } from '../../application/outline/formatRenderedTree.js';
import { BrowserUnavailableError } from '../preview/BrowserPreview.js';
import type { PreviewBrowser } from '../preview/BrowserPreview.js';
import { CREATES, READ_ONLY, defineInput, documentPath, fail, statePath, succeed } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

const APP_ID = { type: 'string', uuid: true, required: true, description: 'The application id from ui_app_create or ui_app_list' } as const;

const APP_CREATE = defineInput({
    name: { type: 'string', required: true, description: 'The application name; unique among the applications' },
    document: { type: 'object', description: 'An optional starting document as a JSON object; without it the app starts as an empty page' },
    sync: {
        type: 'string',
        enum: ['full', 'persisted'],
        description:
            'full (default): the server keeps the state and ui_state_set may change it. persisted: the statenet keeps it and the views sync with it directly; the tools only read it. Needs a server started with --statenet'
    }
});

const APP_LIST = defineInput({});

const APP_GET = defineInput({
    appId: APP_ID,
    path: { type: 'string', description: 'A path such as "app.children.main" or "data.orders" (a leading "$." is allowed); without it the whole document' },
    depth: { type: 'integer', minimum: 0, description: 'How many children levels to include; deeper nodes come back as { component, childCount }' },
    resolved: { type: 'boolean', description: 'true: merge in component defaults. Read only; never write a resolved value back' }
});

const VALIDATE = defineInput({
    appId: { type: 'string', uuid: true, description: 'An application of the old store: its id from ui_app_create or ui_app_list' },
    app: { type: 'string', description: 'An app of parts: its name from ui_list (kind "apps"). Give appId or app' }
});

const OUTLINE = defineInput({
    appId: APP_ID,
    path: { type: 'string', description: 'A node path such as "app.children.main" (a leading "$." is allowed); without it the app root' },
    depth: { type: 'integer', minimum: 0, description: 'How many children levels to show; deeper nodes are one line with a child count' },
    locale: { type: 'string', description: 'Show content in this language when the app has an overlay for it' }
});

const TREE = defineInput({
    appId: APP_ID,
    path: { type: 'string', description: 'The node to start at, such as "$.app.children.main" or "app.children.main"; without it the app root' },
    depth: { type: 'integer', minimum: 0, description: 'How many levels to show below path; deeper nodes are counted on the line of their ancestor' },
    paths: { type: 'boolean', description: 'false: leave the state path off each line, for a shorter tree. Default true' },
    rendered: {
        type: 'boolean',
        description:
            'true: list what the headless page draws instead of the document, with the runtime paths of rows and cards. Opens the headless page when none is open'
    }
});

function notFound(appId: string): ToolOutcome {
    return fail('not-found', 'No application with this id', { appId });
}

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

/** The lifecycle and read tools: create, list, get, validate, outline and read the state */
export function createAppTools(
    useCases: Pick<UiBuilderUseCases, 'createApp' | 'listApps' | 'getApp' | 'validateApp' | 'validatePartApp' | 'outlineApp' | 'getState'>,
    /** The headless page, for ui_tree with rendered: true; absent, that answers browser-unavailable */
    browser?: Pick<PreviewBrowser, 'rendered'>
): readonly UiToolDefinition[] {
    return [
        {
            name: 'ui_app_create',
            description:
                'Create an app, empty or from a starting document. The document is validated first: on blocking errors nothing is created and the errors come back with their state paths. Returns { appId, revision }.',
            inputSchema: APP_CREATE.schema,
            annotations: CREATES,
            run: async (args) => {
                const parsed = APP_CREATE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const result = await useCases.createApp.execute({
                    name: parsed.value.name,
                    ...(parsed.value.document !== undefined && { document: parsed.value.document }),
                    ...(parsed.value.sync !== undefined && { sync: parsed.value.sync })
                });
                switch (result.kind) {
                    case 'created':
                        return succeed({ appId: result.appId, revision: result.revision });
                    case 'invalid':
                        return fail('invalid-document', 'The document has blocking errors; nothing was created', { errors: result.errors });
                    case 'invalid-name':
                        return fail('invalid-name', 'The name must not be blank');
                    case 'duplicate-name':
                        return fail('duplicate-name', 'An application with this name already exists');
                    case 'no-statenet':
                        return fail('no-statenet', 'A persisted app needs the server to run with --statenet');
                }
            }
        },
        {
            name: 'ui_app_list',
            description: 'List the applications: appId, name, owner, revision and last update. No documents.',
            inputSchema: APP_LIST.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = APP_LIST.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const apps = await useCases.listApps.execute();
                return succeed({ count: apps.length, apps });
            }
        },
        {
            name: 'ui_app_get',
            description:
                'Read the app document or part of it, by path and to a depth, optionally with component defaults merged in (resolved: read only). Returns { appId, revision, path, value }; a missing path reports where it stops existing.',
            inputSchema: APP_GET.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = APP_GET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, depth, resolved } = parsed.value;
                const result = await useCases.getApp.execute(appId, {
                    ...(path !== undefined && { path: documentPath(path) }),
                    ...(depth !== undefined && { depth }),
                    ...(resolved !== undefined && { resolved })
                });
                switch (result.kind) {
                    case 'found':
                        return succeed({
                            appId: result.appId,
                            revision: result.revision,
                            path: result.path,
                            value: result.value,
                            resolved: result.resolved,
                            ...(result.note !== undefined && { note: result.note })
                        });
                    case 'not-found':
                        return notFound(result.appId);
                    case 'invalid-path':
                        return fail('invalid-path', result.reason, { appId: result.appId });
                    case 'missing-path':
                        return fail('missing-path', `Nothing exists at ${result.missingAt}`, { appId: result.appId, path: result.path, missingAt: result.missingAt });
                    case 'invalid-input':
                        return fail('invalid-argument', result.message, { appId: result.appId });
                }
            }
        },
        {
            name: 'ui_validate',
            description:
                'Validate a stored application. With appId (an application of the old store) returns { appId, revision, valid, errors, warnings, preview }: each error and warning has a code and the state path it concerns; preview says whether a preview is open and lists its runtime errors. With app (an app of parts) it validates the app assembled with every part it uses and returns { app, revision, valid, errors, warnings, uses }: each error and warning also names the part that holds it, and uses lists the parts the app names.',
            inputSchema: VALIDATE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = VALIDATE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, app } = parsed.value;
                if ((appId === undefined) === (app === undefined)) {
                    return fail('invalid-argument', 'Give appId (an application of the old store) or app (an app of parts), not both', { argument: appId === undefined ? 'app' : 'appId' });
                }
                if (app !== undefined) {
                    if (useCases.validatePartApp === undefined) return fail('not-found', `No app named "${app}"`, { app });
                    const part = await useCases.validatePartApp.execute(app);
                    if (part.kind === 'not-found') return fail('not-found', `No app named "${app}"; ui_list lists the apps`, { app });
                    return succeed({ app: part.app, revision: part.revision, valid: part.valid, errors: part.errors, warnings: part.warnings, uses: part.uses });
                }
                const result = await useCases.validateApp.execute(appId as string);
                if (result.kind === 'not-found') return notFound(result.appId);
                return succeed({
                    appId: result.appId,
                    revision: result.revision,
                    valid: result.valid,
                    errors: result.errors,
                    warnings: result.warnings,
                    preview: result.preview
                });
            }
        },
        {
            name: 'ui_tree',
            description:
                'List the structure of the app as a nested list, one line per node: key, component and path, two spaces per level, bullets alternating - and *. [slot] marks a node held by a slot property (a footer, a row template); a row template draws once per record and has no element of its own. rendered: true lists what the headless page draws instead: each row and card with its runtime path (such as ...board.cols.k_open.body.main.slots.0), the path ui_interact and ui_screenshot need for it; a node with no box is (hidden) and its subtree is counted, not listed. path starts at a node, depth limits the levels, paths: false leaves the paths off. ui_outline shows the content. Capped at 400 lines. Returns { appId, revision, text, lineCount, cutLines, nodeCount }.',
            inputSchema: TREE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = TREE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, depth, paths, rendered } = parsed.value;
                if (rendered === true) {
                    const app = await useCases.getApp.execute(appId, { depth: 0 });
                    if (app.kind !== 'found') return notFound(appId);
                    if (browser === undefined) return fail('browser-unavailable', 'This server has no headless browser, so it cannot list what the page draws');
                    const under = path === undefined ? '$.app' : statePath(path);
                    try {
                        const nodes = await browser.rendered(appId, app.revision, under);
                        if (nodes.length === 0) {
                            return fail('not-rendered', `The page draws nothing at ${under}; check the path with ui_tree, and open what holds it (a tab, a drawer)`, { appId, path: under });
                        }
                        const tree = formatRenderedTree({ nodes, depth, paths: paths !== false });
                        return succeed({ appId, revision: app.revision, text: tree.text, lineCount: tree.lineCount, cutLines: tree.cutLines, nodeCount: tree.nodeCount });
                    } catch (error) {
                        if (error instanceof BrowserUnavailableError) return fail('browser-unavailable', error.message);
                        throw error;
                    }
                }
                const result = await useCases.outlineApp.execute(appId, {
                    format: 'tree',
                    ...(path !== undefined && { path: documentPath(path) }),
                    ...(depth !== undefined && { depth }),
                    ...(paths !== undefined && { paths })
                });
                switch (result.kind) {
                    case 'outline':
                        return succeed({
                            appId: result.appId,
                            revision: result.revision,
                            text: result.text,
                            lineCount: result.lineCount,
                            cutLines: result.cutLines,
                            nodeCount: result.nodeCount ?? 0
                        });
                    case 'not-found':
                        return notFound(result.appId);
                    case 'invalid-path':
                        return fail('invalid-path', result.reason, { appId: result.appId });
                    case 'missing-path':
                        return fail('missing-path', `Nothing exists at ${result.missingAt}`, { appId: result.appId, path: result.path, missingAt: result.missingAt });
                    case 'not-a-node':
                        return fail('not-a-node', `${result.path} is not a node, so it has no tree`, { appId: result.appId, path: result.path });
                    case 'invalid-input':
                        return fail('invalid-argument', result.message, { appId: result.appId });
                }
            }
        },
        {
            name: 'ui_outline',
            description:
                'Get a text outline of what the user sees: one line per node with component, key, text, links and hidden or closed marks (no data values). From the root it ends with the logic: each machine with its current state, and the tables. Capped at 400 lines; the result says how many were cut.',
            inputSchema: OUTLINE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = OUTLINE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, depth, locale } = parsed.value;
                const result = await useCases.outlineApp.execute(appId, {
                    ...(path !== undefined && { path: documentPath(path) }),
                    ...(depth !== undefined && { depth }),
                    ...(locale !== undefined && { locale })
                });
                switch (result.kind) {
                    case 'outline':
                        return succeed({
                            appId: result.appId,
                            revision: result.revision,
                            text: result.text,
                            lineCount: result.lineCount,
                            cutLines: result.cutLines,
                            localeApplied: result.localeApplied
                        });
                    case 'not-found':
                        return notFound(result.appId);
                    case 'invalid-path':
                        return fail('invalid-path', result.reason, { appId: result.appId });
                    case 'missing-path':
                        return fail('missing-path', `Nothing exists at ${result.missingAt}`, { appId: result.appId, path: result.path, missingAt: result.missingAt });
                    case 'not-a-node':
                        return fail('not-a-node', `${result.path} is not a node, so it has no outline`, { appId: result.appId, path: result.path });
                    case 'invalid-input':
                        return fail('invalid-argument', result.message, { appId: result.appId });
                }
            }
        }
    ];
}
