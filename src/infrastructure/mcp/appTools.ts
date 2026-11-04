import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { formatRenderedTree } from '../../application/outline/formatRenderedTree.js';
import { BrowserUnavailableError } from '../preview/BrowserPreview.js';
import type { PreviewBrowser } from '../preview/BrowserPreview.js';
import { CREATES, READ_ONLY, defineInput, fail, succeed } from './toolKit.js';
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
    path: { type: 'string', description: 'A dotted document path such as "app.children.main"; without it the whole document' },
    depth: { type: 'integer', minimum: 0, description: 'How many children levels to include; deeper nodes come back as { component, childCount }' },
    resolved: { type: 'boolean', description: 'true: merge in component defaults. Read only; never write a resolved value back' }
});

const VALIDATE = defineInput({ appId: APP_ID });

const OUTLINE = defineInput({
    appId: APP_ID,
    path: { type: 'string', description: 'A dotted document path to a node; without it the application root' },
    depth: { type: 'integer', minimum: 0, description: 'How many children levels to show; deeper nodes are one line with a child count' },
    locale: { type: 'string', description: 'Show content in this language when the app has an overlay for it' }
});

const TREE = defineInput({
    appId: APP_ID,
    path: { type: 'string', description: 'The node to start at, as a state path ("$.app.children.main") or a dotted document path ("app.children.main"); without it the application root' },
    depth: { type: 'integer', minimum: 0, description: 'How many children levels to show; deeper nodes end their line with a child count' },
    paths: { type: 'boolean', description: 'false: leave the state path off each line, for a shorter tree. Default true' },
    rendered: {
        type: 'boolean',
        description:
            'true: list what the headless page draws instead of the document: the rows of lists and the cards of boards with the state paths they have while the app runs (such as "…board.cols.k_open.body.main.slots.0"), and (hidden) on nodes with no box. Opens the headless page when none is open'
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
    useCases: Pick<UiBuilderUseCases, 'createApp' | 'listApps' | 'getApp' | 'validateApp' | 'outlineApp' | 'getState'>,
    /** The headless page, for ui_tree with rendered: true; absent, that answers browser-unavailable */
    browser?: Pick<PreviewBrowser, 'rendered'>
): readonly UiToolDefinition[] {
    return [
        {
            name: 'ui_app_create',
            description:
                'Create an application, empty or from a starting document. The document is validated first; blocking errors are returned with their state paths and nothing is created. Returns { appId, revision }.',
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
                'Read an application or part of it: by dotted path, limited depth, optionally with component defaults merged in (read only). Returns { appId, revision, path, value }. A missing path reports where it stops existing.',
            inputSchema: APP_GET.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = APP_GET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, depth, resolved } = parsed.value;
                const result = await useCases.getApp.execute(appId, {
                    ...(path !== undefined && { path }),
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
                'Validate the stored application. Returns { appId, revision, valid, errors, warnings, preview }: each error and warning has a code and the state path it concerns; preview says whether a preview is open and lists its runtime errors.',
            inputSchema: VALIDATE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = VALIDATE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const result = await useCases.validateApp.execute(parsed.value.appId);
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
                'Get the structure of the app as a nested list: one line per node with its key, its component and its state path, indented two spaces per level, bullets alternating - and * by level. Nodes held by a slot property (a footer, a row template) are marked [slot]; a row template draws once per record. The paths are the ones ui_interact, ui_state_set and ui_screenshot take. path starts the tree at a node, depth limits the children levels and paths: false leaves the paths off. rendered: true lists what the running page draws instead, with the paths of rendered rows and cards (a document path such as ...card has no element of its own; the drawn cards have paths like ...cols.k_open.body.main.slots.0), and marks nodes with no box (hidden) with their subtree counted. Use ui_outline for content, links and hidden marks. Capped at 400 lines. Returns { appId, revision, text, lineCount, cutLines, nodeCount }.',
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
                    const under = path === undefined ? '$.app' : path.startsWith('$.') ? path : `$.${path}`;
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
                    ...(path !== undefined && { path: path.replace(/^\$\./, '') }),
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
                'Get a text outline of what the user will see: one line per node with its component, key, text, links and hidden or closed marks. Data values are not shown. Capped at 400 lines; the result says how many were cut.',
            inputSchema: OUTLINE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = OUTLINE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, depth, locale } = parsed.value;
                const result = await useCases.outlineApp.execute(appId, {
                    ...(path !== undefined && { path }),
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
