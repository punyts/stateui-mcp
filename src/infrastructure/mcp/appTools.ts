import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
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

function notFound(appId: string): ToolOutcome {
    return fail('not-found', 'No application with this id', { appId });
}

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

/** The lifecycle and read tools: create, list, get, validate, outline and read the state */
export function createAppTools(
    useCases: Pick<UiBuilderUseCases, 'createApp' | 'listApps' | 'getApp' | 'validateApp' | 'outlineApp' | 'getState'>
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
