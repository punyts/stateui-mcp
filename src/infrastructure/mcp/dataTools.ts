import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { DataOperation } from '../../application/use-cases/WriteData.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { MAX_OPERATIONS_PER_WRITE } from '../../domain/limits.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { READ_ONLY, WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { ParsedArguments, ToolOutcome, UiToolDefinition } from './toolKit.js';

/** Records a query returns when its window gives no count */
export const DEFAULT_QUERY_COUNT = 20;
/** Records a query returns at most */
export const MAX_QUERY_COUNT = 100;

const DATASET = { type: 'string', required: true, description: 'The dataset name (ui_list kind "data")' } as const;

const DATA_ITEMS = {
    op: {
        type: 'string',
        required: true,
        enum: ['add', 'set', 'merge', 'remove', 'move'],
        description:
            'add puts a new record under a generated key (returned in "added"); set replaces a record or one of its fields; merge deep-merges an object into it; remove deletes a record or a field; move reorders a record'
    },
    path: {
        type: 'string',
        description: 'Not for add: a path below the records, such as "p1" (a record) or "p1.price" (one of its fields). For move: the record to move'
    },
    value: { type: 'json', description: 'add: the new record (an object); set: the new value; merge: an object. Not for remove or move' },
    before: { type: 'string', description: 'move only: a record key to place the record before' },
    after: { type: 'string', description: 'move only: a record key to place the record after' }
} as const;

const DATA_WRITE = defineInput({
    dataset: DATASET,
    model: { type: 'string', description: 'The model of a dataset this write creates (ui_list kind "models"): a missing dataset is created with it. For an existing dataset leave it out' },
    expectedRevision: {
        type: 'integer',
        minimum: 1,
        description:
            'Optional: the revision you last read. Running apps change datasets too, so leave it out to apply the operations to the newest records; give it to refuse the write when anything changed since'
    },
    operations: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: `The record changes, applied in order as one checked write (at most ${MAX_OPERATIONS_PER_WRITE}). Every record they touch is checked against the model; nothing is written unless all fit`,
        items: DATA_ITEMS
    }
});

const DATA_QUERY = defineInput({
    dataset: DATASET,
    filter: { type: 'string', description: 'An expression over $record and $key, as in the logic query command, such as "$record.price > 10"' },
    sort: { type: 'json', description: 'A field name ("price", or "-price" for descending) or { by, direction: "asc" | "desc" }' },
    window: {
        type: 'object',
        description: `{ first, count }: the offset of the first record to return and how many (default first 0, count ${DEFAULT_QUERY_COUNT}, at most ${MAX_QUERY_COUNT})`
    }
});

type DataItem = ParsedArguments<typeof DATA_ITEMS>;

function misplaced(index: number, name: string, message: string): ToolOutcome {
    return fail('invalid-argument', `operations[${index}].${name} ${message}`, { argument: `operations[${index}].${name}` });
}

/** One parsed item as a data operation, or the argument error for a missing or misplaced field */
function toOperation(item: DataItem, index: number): DataOperation | ToolOutcome {
    const allowed: Record<DataItem['op'], readonly (keyof DataItem)[]> = {
        add: ['value'],
        set: ['path', 'value'],
        merge: ['path', 'value'],
        remove: ['path'],
        move: ['path', 'before', 'after']
    };
    const extra = (['path', 'value', 'before', 'after'] as const).find((name) => item[name] !== undefined && !allowed[item.op].includes(name));
    if (extra !== undefined) return misplaced(index, extra, `is not allowed for ${item.op}`);
    if (item.op === 'add') {
        if (!isJsonObject(item.value)) return misplaced(index, 'value', 'is required for add and must be a record object');
        return { op: 'add', value: item.value };
    }
    if (item.path === undefined || item.path === '') return misplaced(index, 'path', `is required for ${item.op}: a record key, or a key and a field ("p1.price")`);
    switch (item.op) {
        case 'set':
        case 'merge':
            if (item.value === undefined) return misplaced(index, 'value', `is required for ${item.op}`);
            return { op: item.op, path: item.path, value: item.value };
        case 'remove':
            return { op: 'remove', path: item.path };
        case 'move':
            if (item.before !== undefined && item.after !== undefined) return misplaced(index, 'after', 'cannot be given with before');
            return { op: 'move', path: item.path, ...(item.before !== undefined && { before: item.before }), ...(item.after !== undefined && { after: item.after }) };
    }
}

const RECORD_PATH = /^\$\.records\.([^.]+)(?:\.([^.]+))?/;
/** The field of a `SUI-MODEL-FIELD` error, whose path names the record only: `Field "{name}" of record "{key}" ...` */
const FIELD_MESSAGE = /^Field "([^"]+)" of record "/;

/** Each error with the record key and the field it names, when its path is under a record */
function withRecords(errors: readonly UiBuildError[]): Record<string, unknown>[] {
    return errors.map((error) => {
        const match = RECORD_PATH.exec(error.statePath ?? '');
        const field = match?.[2] ?? (error.code === 'SUI-MODEL-FIELD' ? FIELD_MESSAGE.exec(error.message)?.[1] : undefined);
        return { ...error, ...(match?.[1] !== undefined && { record: match[1] }), ...(field !== undefined && { field }) };
    });
}

/** The window of a query, or the argument error */
function readWindow(window: Record<string, unknown> | undefined): { first: number; count: number } | ToolOutcome {
    const first = window?.['first'] ?? 0;
    const count = window?.['count'] ?? DEFAULT_QUERY_COUNT;
    const extra = Object.keys(window ?? {}).find((key) => key !== 'first' && key !== 'count');
    if (extra !== undefined) return fail('invalid-argument', `window has no "${extra}"; it takes first and count`, { argument: `window.${extra}` });
    if (!Number.isInteger(first) || (first as number) < 0) return fail('invalid-argument', 'window.first must be an integer of 0 or more', { argument: 'window.first' });
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_QUERY_COUNT) {
        return fail('invalid-argument', `window.count must be an integer from 1 to ${MAX_QUERY_COUNT}`, { argument: 'window.count' });
    }
    return { first: first as number, count: count as number };
}

/** `ui_data_write` and `ui_data_query`, when the server has parts */
export function createDataTools(useCases: Pick<UiBuilderUseCases, 'writeData' | 'queryData'>): readonly UiToolDefinition[] {
    const { writeData, queryData } = useCases;
    const tools: UiToolDefinition[] = [];
    if (writeData !== undefined) {
        tools.push({
            name: 'ui_data_write',
            description:
                'Build and run time: add, set, merge, remove or move records of an owner dataset: seed data at build time, corrections while apps run. A missing dataset is created by its first write, which names its model. add gives the record a generated key (never integer-like) and returns it in "added". Paths are below the records: "p1" is a record, "p1.price" one of its fields. Every record the write touches is checked against the dataset\'s model; a record that does not fit refuses the whole write (invalid-records, each error naming its record and field). expectedRevision is optional: running apps change datasets too, so without it the operations apply to the newest records. Every open app bound to the dataset shows the change at once. Returns { dataset, revision, created, added }.',
            inputSchema: DATA_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = DATA_WRITE.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { dataset, model, expectedRevision } = parsed.value;
                const operations: DataOperation[] = [];
                for (const [index, item] of parsed.value.operations.entries()) {
                    const converted = toOperation(item, index);
                    if (!('op' in converted)) return converted;
                    operations.push(converted);
                }
                const result = await writeData.execute({
                    name: dataset,
                    operations,
                    ...(model !== undefined && { model }),
                    ...(expectedRevision !== undefined && { expectedRevision })
                });
                switch (result.kind) {
                    case 'written':
                        return succeed({ dataset, revision: result.revision, created: result.created, added: result.added });
                    case 'invalid':
                        return fail('invalid-records', 'The write does not apply or leaves a record that does not fit the model; nothing was written. Each error names its path, and its record and field when it has them', {
                            errors: withRecords(result.errors)
                        });
                    case 'conflict':
                        return fail('conflict', `The dataset is at revision ${result.currentRevision}, not the revision expected; nothing was written. Read it again, or leave expectedRevision out`, {
                            currentRevision: result.currentRevision
                        });
                    case 'not-found':
                        return fail(
                            'not-found',
                            `No dataset named "${dataset}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : ''}. To create it, give its model and leave expectedRevision out`,
                            { argument: 'dataset', nearest: result.nearest }
                        );
                    case 'invalid-name':
                        return fail('invalid-name', result.reason, { argument: 'dataset' });
                    case 'model-not-found':
                        return fail('not-found', `No model named "${model ?? ''}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; create it with ui_model_write'}`, {
                            argument: 'model',
                            nearest: result.nearest
                        });
                    case 'model-mismatch':
                        return fail('invalid-argument', `The dataset "${dataset}" has the model "${result.model}"; leave model out to write its records`, { argument: 'model' });
                }
            }
        });
    }
    if (queryData !== undefined) {
        tools.push({
            name: 'ui_data_query',
            description: `Build and run time: read records of an owner dataset, filtered, sorted and windowed. filter is an expression over $record and $key ("$record.price > 10"); sort a field name ("-price" for descending) or { by, direction }; window { first, count } (count ${DEFAULT_QUERY_COUNT} by default, at most ${MAX_QUERY_COUNT}). Returns { dataset, revision, records: [{ key, record }], first, total }, where total counts every matching record before the window.`,
            inputSchema: DATA_QUERY.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = DATA_QUERY.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { dataset, filter, sort, window } = parsed.value;
                const range = readWindow(window as Record<string, unknown> | undefined);
                if (!('first' in range)) return range;
                const result = await queryData.execute({
                    name: dataset,
                    window: range,
                    ...(filter !== undefined && { filter }),
                    ...(sort !== undefined && { sort })
                });
                switch (result.kind) {
                    case 'found':
                        return succeed({ dataset, revision: result.revision, records: result.records, first: result.first, total: result.total });
                    case 'invalid':
                        return fail('invalid-argument', result.reason, { argument: 'filter' });
                    case 'not-found':
                        return fail('not-found', `No dataset named "${dataset}"`, { argument: 'dataset' });
                }
            }
        });
    }
    return tools;
}
