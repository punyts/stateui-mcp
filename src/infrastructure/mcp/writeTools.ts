import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { WriteOperation } from '../../domain/documentOperations.js';
import { MAX_OPERATIONS_PER_WRITE } from '../../domain/limits.js';
import { WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { ParsedArguments, ToolOutcome, UiToolDefinition } from './toolKit.js';

const APP_ID = { type: 'string', uuid: true, required: true, description: 'The application id from ui_app_create or ui_app_list' } as const;

const EXPECTED_REVISION = {
    type: 'integer',
    minimum: 1,
    description: 'The revision you last read. When the app has changed since, nothing is written and the result says the current revision'
} as const;

const APP_WRITE_ITEMS = {
            op: { type: 'string', required: true, enum: ['set', 'remove', 'merge', 'move'], description: 'set replaces or appends a key, remove deletes it, merge deep-merges an object and creates missing keys, move relocates a keyed entry with its subtree and key' },
            path: { type: 'string', required: true, allowEmpty: true, description: 'A dotted path from the document root, such as "app.children.footer._title"; "" is the root. For move: the entry to move' },
            value: { type: 'json', description: 'The new value for set; an object for merge; not allowed for remove or move' },
            to: { type: 'string', description: 'move only: the keyed map to move the entry into, such as "app.children.panel.children"; the entry goes at the end unless before or after is given' },
            before: { type: 'string', description: 'move only: a sibling key to place the entry before (in the map named by to, or in its own map without to)' },
            after: { type: 'string', description: 'move only: a sibling key to place the entry after (in the map named by to, or in its own map without to)' }
} as const;

const APP_WRITE = defineInput({
    appId: APP_ID,
    operations: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: `The changes, applied in order as one validated transaction (at most ${MAX_OPERATIONS_PER_WRITE}). Nothing is written unless the whole result is valid`,
        items: APP_WRITE_ITEMS
    },
    expectedRevision: EXPECTED_REVISION
});

const STATE_SET = defineInput({
    appId: APP_ID,
    path: { type: 'string', required: true, description: 'A "$.data..." path, or "$.app...<node path>.<property>" for a property the user can change' },
    value: { type: 'json', description: 'The new value; leave it out with remove' },
    remove: { type: 'boolean', description: 'true: remove the entry at a "$.data..." path, such as a record, instead of setting a value' },
    logic: {
        type: 'boolean',
        description: 'false: write the value as it is, with no guard asking and no rule or machine firing, to set up a test state. Default true: the write is a change like a user\'s'
    },
    expectedRevision: EXPECTED_REVISION
});

const STATE_RESET = defineInput({ appId: APP_ID, expectedRevision: EXPECTED_REVISION });

function notFound(appId: string): ToolOutcome {
    return fail('not-found', 'No application with this id', { appId });
}

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

function conflict(appId: string, currentRevision: number): ToolOutcome {
    return fail('conflict', `The application is at revision ${currentRevision}, not the revision expected. Read it again with ui_app_get and repeat the write; nothing was written`, {
        appId,
        currentRevision
    });
}

type OperationItem = ParsedArguments<typeof APP_WRITE_ITEMS>;

function misplaced(index: number, name: string, message: string): ToolOutcome {
    return fail('invalid-argument', `operations[${index}].${name} ${message}`, { argument: `operations[${index}].${name}` });
}

/** Turns one parsed item into a write operation, or the argument error for a field the operation does not take */
function toOperation(item: OperationItem, index: number): WriteOperation | ToolOutcome {
    if (item.op === 'move') {
        if (item.value !== undefined) return misplaced(index, 'value', 'is not allowed for move');
        return {
            op: 'move',
            path: item.path,
            ...(item.to !== undefined && { to: item.to }),
            ...(item.before !== undefined && { before: item.before }),
            ...(item.after !== undefined && { after: item.after })
        };
    }
    for (const name of ['to', 'before', 'after'] as const) {
        if (item[name] !== undefined) return misplaced(index, name, `is only allowed for move, not ${item.op}`);
    }
    if (item.op === 'remove') {
        if (item.value !== undefined) return misplaced(index, 'value', 'is not allowed for remove');
        return { op: 'remove', path: item.path };
    }
    if (item.value === undefined) return misplaced(index, 'value', `is required for ${item.op}`);
    return { op: item.op, path: item.path, value: item.value };
}

/** The write tools: change the document or the state. Every open view follows the change at once */
export function createWriteTools(
    useCases: Pick<UiBuilderUseCases, 'writeApp' | 'setState' | 'resetState'>,
    live: Pick<LiveViews, 'documentChanged'>
): readonly UiToolDefinition[] {
    return [
        {
            name: 'ui_app_write',
            description: `Change the application document with set, remove, merge and move operations by dotted path (at most ${MAX_OPERATIONS_PER_WRITE} per call). move relocates a keyed entry with its subtree: { op: "move", path, before | after } reorders it among its siblings, { op: "move", path, to, before? | after? } moves it into another map. Later operations use the new paths. The operations apply in order to a copy; the whole result is validated and committed as one write, or not at all. A set through a missing parent fails: write the parent first or use merge. Pass expectedRevision from your last read to detect a change made in between. Returns { appId, revision, warnings }; blocking errors are returned in full with their state paths and nothing is written.`,
            inputSchema: APP_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = APP_WRITE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const operations: WriteOperation[] = [];
                for (const [index, item] of parsed.value.operations.entries()) {
                    const converted = toOperation(item, index);
                    if (!('op' in converted)) return converted;
                    operations.push(converted);
                }
                const { appId, expectedRevision } = parsed.value;
                const result = await useCases.writeApp.execute(appId, operations, expectedRevision);
                switch (result.kind) {
                    case 'written':
                        await live.documentChanged(result.appId);
                        return succeed({ appId: result.appId, revision: result.revision, warnings: result.warnings });
                    case 'invalid':
                        return fail('invalid-document', 'The result has blocking errors or the call is over a limit; nothing was written', {
                            appId: result.appId,
                            errors: result.errors
                        });
                    case 'invalid-operation':
                        return fail('invalid-operation', `Operation ${result.index} could not be applied: ${result.error.message}`, {
                            appId: result.appId,
                            index: result.index,
                            errors: [result.error]
                        });
                    case 'conflict':
                        return conflict(result.appId, result.currentRevision);
                    case 'not-found':
                        return notFound(result.appId);
                }
            }
        },
        {
            name: 'ui_state_set',
            description:
                'Set one value in the app\'s state: a "$.data..." path, or a property of a node such as "$.app.children.name.value". remove: true instead of a value removes an entry under $.data, such as a deleted record ($.data.tasks.t2); a null value would leave an empty record behind. Open views get the change at once. Links, runtime and exposed properties are refused with the reason. The write is a change like a user\'s: guards may refuse it and rules fire; logic: false writes it as it is. Content text of an app with an active language is changed with ui_app_write instead. The revision counts document writes, so it stays as it is. Returns { appId, revision, path }.',
            inputSchema: STATE_SET.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = STATE_SET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, value, remove, logic, expectedRevision } = parsed.value;
                if (remove === true && value !== undefined) return fail('invalid-argument', 'Pass value or remove: true, not both', { argument: 'remove' });
                if (remove !== true && value === undefined) return fail('invalid-argument', 'value is required, or remove: true to remove the entry', { argument: 'value' });
                const result = await useCases.setState.execute(appId, {
                    path,
                    ...(remove === true ? { remove } : { value }),
                    ...(expectedRevision !== undefined && { expectedRevision }),
                    ...(logic === false && { logic })
                });
                switch (result.kind) {
                    case 'written':
                        return succeed({ appId: result.appId, revision: result.revision, path: result.path });
                    case 'refused':
                        return fail(result.reason, result.message, { appId: result.appId });
                    case 'invalid':
                        return fail('invalid-value', 'The value does not fit this path; nothing was written', { appId: result.appId, errors: result.errors });
                    case 'conflict':
                        return conflict(result.appId, result.currentRevision);
                    case 'not-found':
                        return notFound(result.appId);
                }
            }
        },
        {
            name: 'ui_state_reset',
            description:
                'Put the app\'s state back to its document: $.data becomes the document\'s data again and every articulation a user or a tool changed under $.app is dropped (what was typed, picked, opened). No guard asks and no rule fires; then the logic starts again, so machines are in their initial states and the logic trace is empty. Open views get the reset at once. Use it between test runs. The revision counts document writes, so it stays as it is. Returns { appId, revision }.',
            inputSchema: STATE_RESET.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = STATE_RESET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const result = await useCases.resetState.execute(parsed.value.appId, parsed.value.expectedRevision);
                switch (result.kind) {
                    case 'reset':
                        return succeed({ appId: result.appId, revision: result.revision });
                    case 'persisted-app':
                        return fail('persisted-app', 'The app is Persisted: its state lives in the statenet and only its views change it', { appId: result.appId });
                    case 'conflict':
                        return conflict(result.appId, result.currentRevision);
                    case 'not-found':
                        return notFound(result.appId);
                }
            }
        }
    ];
}
