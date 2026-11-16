import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { PART_KINDS } from '../../domain/partName.js';
import type { PartKind } from '../../domain/partName.js';
import type { LiveViews } from '../preview/LiveViews.js';
import { DESTROYS, READ_ONLY, defineInput, documentPath, fail, succeed } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

/** The kinds the generic tools take: the part kinds and the screens of an app */
export const LIST_KINDS = [...PART_KINDS, 'screens'] as const;
type ListKind = (typeof LIST_KINDS)[number];

const KIND = {
    type: 'string',
    enum: LIST_KINDS,
    required: true,
    description: 'apps, themes, logic (modules), models, data (datasets), components, patterns, or screens (of the app named by app)'
} as const;
const NAME = { type: 'string', required: true, description: 'The part name (a slug such as "order-form"), or the screen name with kind "screens"' } as const;
const APP = { type: 'string', description: 'With kind "screens": the app whose screens these are' } as const;
const EXPECTED = {
    type: 'integer',
    minimum: 1,
    required: true,
    description: 'The revision you last read (for a screen, its app\'s). When it has changed since, nothing changes and the result says the current revision'
} as const;

const LIST = defineInput({
    kind: KIND,
    query: { type: 'string', description: 'Words that must all be in the name or title, ignoring case; without it everything of the kind' },
    app: APP
});

const GET = defineInput({
    kind: KIND,
    name: NAME,
    app: APP,
    path: { type: 'string', description: 'A path inside the part such as "screens.home.root" or "records.p1" (a leading "$." is allowed); without it the whole part' },
    depth: { type: 'integer', minimum: 0, description: 'How many children levels of each node to include; deeper nodes come back as { component, childCount }' },
    resolved: { type: 'boolean', description: 'Apps only. true: the assembled app the runtime mounts, with its themes, data, components and modules merged in. Read only; never write it back' }
});

const DELETE = defineInput({ kind: KIND, name: NAME, app: APP, expectedRevision: EXPECTED });

const RENAME = defineInput({
    kind: KIND,
    name: NAME,
    to: { type: 'string', required: true, description: 'The new name: lower-case letters, digits and dashes, starting with a letter' },
    app: APP,
    expectedRevision: EXPECTED
});

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

const NO_APP = fail('invalid-argument', 'kind "screens" needs app: the app whose screens these are', { argument: 'app' });
const APP_WITHOUT_SCREENS = fail('invalid-argument', 'app is only for kind "screens"', { argument: 'app' });

/** The app a screen call needs, or the error when it is missing or given for another kind */
function screenApp(kind: ListKind, app: string | undefined): { readonly app?: string; readonly error?: ToolOutcome } {
    if (kind === 'screens') return app === undefined ? { error: NO_APP } : { app };
    return app === undefined ? {} : { error: APP_WITHOUT_SCREENS };
}

function notFound(kind: ListKind, name: string, nearest: readonly string[], app: string | undefined, missingApp: string | undefined): ToolOutcome {
    const what = missingApp !== undefined ? `No app named "${missingApp}"` : kind === 'screens' ? `The app "${app}" has no screen "${name}"` : `No ${kind} part named "${name}"`;
    const hint = nearest.length > 0 ? `; nearest: ${nearest.join(', ')}` : '; ui_list lists the names';
    return fail('not-found', `${what}${hint}`, { kind, name, ...(app !== undefined && { app }), nearest });
}

function conflict(currentRevision: number, what: string): ToolOutcome {
    return fail('conflict', `It is at revision ${currentRevision}, not the revision expected. Read it again with ui_get; nothing was ${what}`, { currentRevision });
}

/** The generic tools of the owner's parts: list, get, delete and rename every kind, and the screens of an app */
export function createPartTools(
    useCases: Pick<UiBuilderUseCases, 'listParts' | 'getPart' | 'deletePart' | 'renamePart'>,
    live: Pick<LiveViews, 'deleted'>
): readonly UiToolDefinition[] {
    const { listParts, getPart, deletePart, renamePart } = useCases;
    if (listParts === undefined || getPart === undefined || deletePart === undefined || renamePart === undefined) return [];
    return [
        {
            name: 'ui_list',
            description:
                'Build time: list the owner\'s parts of one kind (apps, themes, logic modules, models, datasets, components, patterns) or the screens of one app (kind "screens" with app). query keeps the ones with every word in the name or title. Each item has name and revision; an app also its title and uses (themes, data bindings, logic modules); a screen its title and start: true for the start screen, with the app\'s revision on the result. Returns { kind, count, items }.',
            inputSchema: LIST.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = LIST.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { kind, query } = parsed.value;
                const target = screenApp(kind, parsed.value.app);
                if (target.error !== undefined) return target.error;
                const result =
                    kind === 'screens'
                        ? await listParts.execute({ kind, app: target.app as string, ...(query !== undefined && { query }) })
                        : await listParts.execute({ kind, ...(query !== undefined && { query }) });
                switch (result.kind) {
                    case 'listed':
                        return succeed({ kind, count: result.items.length, items: result.items });
                    case 'listed-screens':
                        return succeed({ kind, app: result.app, revision: result.revision, count: result.items.length, items: result.items });
                    case 'not-found':
                        return notFound(kind, result.app, [], undefined, result.app);
                }
            }
        },
        {
            name: 'ui_get',
            description:
                'Build time: read one part (or one screen of an app, kind "screens" with app) with its id and revision, whole or at a path, to a depth. resolved: true on an app reads the assembled app the runtime mounts (read only). Returns { kind, name, id, revision, path, value, resolved }; a missing path reports where it stops existing, a missing name the nearest names.',
            inputSchema: GET.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = GET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { kind, name, path, depth, resolved } = parsed.value;
                const target = screenApp(kind, parsed.value.app);
                if (target.error !== undefined) return target.error;
                const options = {
                    ...(path !== undefined && { path: documentPath(path) }),
                    ...(depth !== undefined && { depth }),
                    ...(resolved !== undefined && { resolved })
                };
                const result =
                    kind === 'screens' ? await getPart.execute({ kind, app: target.app as string, name, ...options }) : await getPart.execute({ kind, name, ...options });
                switch (result.kind) {
                    case 'found':
                        return succeed({
                            kind,
                            name,
                            ...(target.app !== undefined && { app: target.app }),
                            id: result.id,
                            revision: result.revision,
                            path: result.path,
                            value: result.value,
                            resolved: result.resolved,
                            ...(result.note !== undefined && { note: result.note })
                        });
                    case 'not-found':
                        return notFound(kind, name, result.nearest, target.app, result.missingApp);
                    case 'invalid-path':
                        return fail('invalid-path', result.reason, { kind, name });
                    case 'missing-path':
                        return fail('missing-path', `Nothing exists at ${result.missingAt}`, { kind, name, path: result.path, missingAt: result.missingAt });
                    case 'invalid-input':
                        return fail('invalid-argument', result.message, { argument: 'resolved' });
                }
            }
        },
        {
            name: 'ui_delete',
            description:
                'Build time: delete a part for good, or a screen of an app (kind "screens" with app). Ask the user first: it cannot be restored. A part that anything uses is not deleted, and the result names the users (change or delete them first); the start screen of an app is not deleted either. expectedRevision is required (for a screen, the app\'s). Deleting an app also deletes its instance and closes its open views. Returns { kind, name, revision }.',
            inputSchema: DELETE.schema,
            annotations: DESTROYS,
            run: async (args) => {
                const parsed = DELETE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { kind, name, expectedRevision } = parsed.value;
                const target = screenApp(kind, parsed.value.app);
                if (target.error !== undefined) return target.error;
                const result =
                    kind === 'screens'
                        ? await deletePart.execute({ kind, app: target.app as string, name, expectedRevision })
                        : await deletePart.execute({ kind: kind as PartKind, name, expectedRevision });
                switch (result.kind) {
                    case 'deleted':
                        if (kind === 'apps') await live.deleted(result.id);
                        return succeed({ kind, name, ...(target.app !== undefined && { app: target.app }), revision: result.revision });
                    case 'in-use':
                        return fail('in-use', `${result.reason}; nothing was deleted`, { kind, name, users: result.users });
                    case 'conflict':
                        return conflict(result.currentRevision, 'deleted');
                    case 'not-found':
                        return notFound(kind, name, result.nearest, target.app, result.missingApp);
                }
            }
        },
        {
            name: 'ui_rename',
            description:
                'Build time: rename a part, or a screen of an app (kind "screens" with app), and rewrite every part that names it, all together: theme lists, data bindings, logic module keys, models of datasets and modules, component names in nodes; a screen\'s start and the navigate commands to it. Ask the user first. The part keeps its id, so instances and persona data stay. expectedRevision is required (for a screen, the app\'s). Returns { kind, name, revision, rewritten } with the new name, its revision and each rewritten part with its new revision.',
            inputSchema: RENAME.schema,
            annotations: DESTROYS,
            run: async (args) => {
                const parsed = RENAME.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { kind, name, to, expectedRevision } = parsed.value;
                const target = screenApp(kind, parsed.value.app);
                if (target.error !== undefined) return target.error;
                const result =
                    kind === 'screens'
                        ? await renamePart.execute({ kind, app: target.app as string, name, to, expectedRevision })
                        : await renamePart.execute({ kind: kind as PartKind, name, to, expectedRevision });
                switch (result.kind) {
                    case 'renamed':
                        return succeed({ kind, name: to, ...(target.app !== undefined && { app: target.app }), revision: result.revision, rewritten: result.rewritten });
                    case 'invalid':
                        return fail('invalid-name', `${result.reason}; nothing was renamed`, { argument: 'to' });
                    case 'duplicate-name':
                        return fail('duplicate-name', `"${to}" is taken; nothing was renamed`, { kind, name: to });
                    case 'conflict':
                        return conflict(result.currentRevision, 'renamed');
                    case 'not-found':
                        return notFound(kind, name, [], target.app, undefined);
                }
            }
        }
    ];
}

