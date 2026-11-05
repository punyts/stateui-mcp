import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { InstanceViews } from '../preview/InstanceViews.js';
import { isRunTarget, RUN_APP_FIELDS, runName, runTargets } from './runTarget.js';
import { defineInput, fail, READ_ONLY, statePath, succeed, WRITES } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

const EXPECTED_REVISION = {
    type: 'integer',
    minimum: 1,
    description: 'The revision you last read. When the app has changed since, nothing is written and the result says the current revision'
} as const;

const STATE_GET = defineInput({
    ...RUN_APP_FIELDS,
    path: {
        type: 'string',
        description: 'A path to read just that part, such as "$.data.cart" or "$.app.children.main.children.form"; without it the whole state'
    },
    full: { type: 'boolean', description: 'true: return data: URIs and strings over 300 characters whole. By default they are shortened, so an image does not fill the result' }
});

const STATE_SET = defineInput({
    ...RUN_APP_FIELDS,
    path: { type: 'string', required: true, description: 'A data path such as "$.data.cart.c1.qty", or a node property a user can change such as "$.app.children.name.value" or "$.screens.home.children.name.value"' },
    value: { type: 'json', description: 'The new value; leave it out with remove' },
    remove: { type: 'boolean', description: 'true: remove the entry at a "$.data..." path, such as a record, instead of setting a value' },
    logic: {
        type: 'boolean',
        description: 'false: write the value as it is, with no guard asking and no rule or machine firing, to set up a test. Default true: the write counts as a change by the user'
    },
    expectedRevision: EXPECTED_REVISION
});

const STATE_RESET = defineInput({ ...RUN_APP_FIELDS, expectedRevision: EXPECTED_REVISION });

/** Strings longer than this are shortened in ui_state_get unless full is set */
const LONG_STRING = 300;
const KEPT_CHARS = 80;

/** A copy of a value with data: URIs and other long strings shortened to a note of their length */
function elideLong(value: unknown): unknown {
    if (typeof value === 'string') {
        if (value.length <= LONG_STRING) return value;
        if (value.startsWith('data:')) {
            const header = value.slice(0, Math.max(0, value.indexOf(',')) || 40);
            return `${header},… (${value.length} chars; full: true returns it)`;
        }
        return `${value.slice(0, KEPT_CHARS)}… (${value.length} chars; full: true returns it)`;
    }
    if (Array.isArray(value)) return value.map(elideLong);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, elideLong(item)]));
    }
    return value;
}

/** The value at a state path such as `$.data.cart`; the leading `$.` is optional. found is false when a segment is missing */
function valueAt(state: unknown, path: string): { found: boolean; value: unknown; closest: string } {
    const segments = path.replace(/^\$\.?/, '').split('.').filter((segment) => segment !== '');
    let current: unknown = state;
    const walked: string[] = [];
    for (const segment of segments) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
            return { found: false, value: undefined, closest: walked.length === 0 ? '$' : `$.${walked.join('.')}` };
        }
        current = (current as Record<string, unknown>)[segment];
        walked.push(segment);
    }
    return { found: true, value: current, closest: path };
}

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

function conflict(named: Record<string, unknown>, currentRevision: number): ToolOutcome {
    return fail('conflict', `The app is at revision ${currentRevision}, not the revision expected. Read it again and repeat; nothing was written`, { ...named, currentRevision });
}

export interface StateToolDependencies {
    readonly useCases: Pick<
        UiBuilderUseCases,
        'getApp' | 'getState' | 'setState' | 'resetState' | 'findPartApp' | 'getPartState' | 'setPartState' | 'resetInstance'
    >;
    /** The views of app parts; absent, only appId works */
    readonly instanceViews?: Pick<InstanceViews, 'view'>;
}

/** The run-time state tools: read, set and reset the state of an app part's instance (`app`) or of an app of the old store (`appId`) */
export function createStateTools(dependencies: StateToolDependencies): readonly UiToolDefinition[] {
    const { useCases, instanceViews } = dependencies;
    const resolve = runTargets({ useCases, ...(instanceViews !== undefined && { instanceViews }) });
    return [
        {
            name: 'ui_state_get',
            description:
                'Run time: read the app state as { data, app } (and screens and route for an app with screens): the data, and what users typed, picked or opened. With app it reads the instance of the app part from the server (source "instance"). With appId, an app of the old store: with a view open it asks that view (source "live"), else the stored copy (source "stored"). path reads one part. Long strings are shortened unless full is true. Reading changes nothing. Returns { app | appId, revision, source, state, preview }, or with path { app | appId, revision, source, path, value, preview }; revision is the definition\'s, preview says whether a view is open and lists its runtime errors.',
            inputSchema: STATE_GET.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = STATE_GET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { path, full } = parsed.value;
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                let read: { revision: number; source: string; state: unknown; preview: unknown };
                if (target.kind === 'instance' && useCases.getPartState !== undefined) {
                    read = await useCases.getPartState.execute(target.part);
                } else {
                    const result = await useCases.getState.execute(target.appId);
                    if (result.kind === 'not-found') return fail('not-found', 'No application with this id', { appId: target.appId });
                    read = result;
                }
                const named = runName(target);
                const shown = (value: unknown): unknown => (full === true ? value : elideLong(value));
                if (path === undefined) return succeed({ ...named, revision: read.revision, source: read.source, state: shown(read.state), preview: read.preview });
                const at = valueAt(read.state, path);
                if (!at.found) return fail('unknown-path', `Nothing is at ${path}; the closest part that exists is ${at.closest}`, { ...named, path, closest: at.closest });
                return succeed({ ...named, revision: read.revision, source: read.source, path, value: shown(at.value), preview: read.preview });
            }
        },
        {
            name: 'ui_state_set',
            description:
                'Run time: set one value in the state of the instance of an app part (app) or of an app of the old store (appId): a data path or a node property a user can change. remove: true removes an entry under $.data, such as a record ($.data.tasks.t2); null would leave an empty record. The write counts as a change by the user: guards may refuse it and rules fire. logic: false skips both, to set up a test. Never the definition: content, links, runtime and exposed properties are refused with the reason, and with app so are $.theme and the other definition roots (change the part) and a shared dataset (ui_data_write). Open views follow at once. The revision counts definition writes only, so it does not change. Returns { app | appId, revision, path }.',
            inputSchema: STATE_SET.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = STATE_SET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { path, value, remove, logic, expectedRevision } = parsed.value;
                if (remove === true && value !== undefined) return fail('invalid-argument', 'Pass value or remove: true, not both', { argument: 'remove' });
                if (remove !== true && value === undefined) return fail('invalid-argument', 'value is required, or remove: true to remove the entry', { argument: 'value' });
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const named = runName(target);
                const input = {
                    path: statePath(path),
                    ...(remove === true ? { remove } : { value }),
                    ...(expectedRevision !== undefined && { expectedRevision }),
                    ...(logic === false && { logic })
                };
                const result =
                    target.kind === 'instance' && useCases.setPartState !== undefined
                        ? await useCases.setPartState.execute(target.app, input)
                        : await useCases.setState.execute(target.appId, input);
                switch (result.kind) {
                    case 'written':
                        return succeed({ ...named, revision: result.revision, path: result.path });
                    case 'refused':
                        return fail(result.reason, result.message, named);
                    case 'invalid':
                        return fail('invalid-value', 'The value does not fit this path; nothing was written', { ...named, errors: result.errors });
                    case 'conflict':
                        return conflict(named, result.currentRevision);
                    case 'not-found':
                        return fail('not-found', 'No application with this id', named);
                }
            }
        },
        {
            name: 'ui_state_reset',
            description:
                'Run time: put the state back to the definition. With app, the instance of the app part is dropped with the persona\'s own records: the running instance stops, its views reconnect to a fresh one, and its logic starts again. With appId, an app of the old store: $.data becomes the data of the document again and what users or tools changed under $.app is dropped; Full-mode apps only. No guard or rule runs; machines are in their initial states after it and the trace is empty. Open views follow at once. Use it between test runs. The definition and its revision do not change. Returns { app | appId, revision }.',
            inputSchema: STATE_RESET.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = STATE_RESET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { expectedRevision } = parsed.value;
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const named = runName(target);
                if (target.kind === 'instance' && useCases.resetInstance !== undefined) {
                    const result = await useCases.resetInstance.execute(target.app, expectedRevision);
                    switch (result.kind) {
                        case 'reset':
                            return succeed({ ...named, revision: result.revision });
                        case 'conflict':
                            return conflict(named, result.currentRevision);
                        case 'not-found':
                            return fail('not-found', `No app named "${target.app}"`, named);
                    }
                }
                const result = await useCases.resetState.execute(target.appId, expectedRevision);
                switch (result.kind) {
                    case 'reset':
                        return succeed({ ...named, revision: result.revision });
                    case 'persisted-app':
                        return fail('persisted-app', 'The app is Persisted: its state lives in the statenet and only its views change it', named);
                    case 'conflict':
                        return conflict(named, result.currentRevision);
                    case 'not-found':
                        return fail('not-found', 'No application with this id', named);
                }
            }
        }
    ];
}
