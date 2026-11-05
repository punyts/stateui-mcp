import { FIELD_TYPES, VALIDATORS } from '@punyts/stateui-app/core';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { ModelOperation } from '../../application/use-cases/WriteModel.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { MAX_OPERATIONS_PER_WRITE } from '../../domain/limits.js';
import { WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { ParsedArguments, ToolOutcome, UiToolDefinition } from './toolKit.js';

const VALIDATOR_NAMES = Object.keys(VALIDATORS).sort();

const MODEL_ITEMS = {
    op: { type: 'string', required: true, enum: ['set', 'remove'], description: 'set adds a field or replaces its whole declaration; remove takes the field out' },
    field: { type: 'string', required: true, description: 'The field name: letters, digits and underscores, starting with a letter or underscore' },
    type: { type: 'string', enum: FIELD_TYPES, description: 'set only, required: the type of the field\'s values' },
    default: { type: 'json', description: 'set only: the value a record without one takes; it must fit the type and the validators' },
    required: { type: 'boolean', description: 'set only: true when every record must hold a value (unless there is a default)' },
    validators: { type: 'object', description: `set only: validator name to its options, from the closed set: ${VALIDATOR_NAMES.join(', ')}` }
} as const;

const MODEL_WRITE = defineInput({
    model: { type: 'string', required: true, description: 'The model name (ui_list kind "models"); a new name creates the model' },
    expectedRevision: { type: 'integer', minimum: 1, description: 'The revision you last read. Leave it out to create the model; when the model has changed since, nothing is written' },
    operations: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: `The field changes, applied in order as one checked write (at most ${MAX_OPERATIONS_PER_WRITE})`,
        items: MODEL_ITEMS
    }
});

type ModelItem = ParsedArguments<typeof MODEL_ITEMS>;

function misplaced(index: number, name: string, message: string, details: Record<string, unknown> = {}): ToolOutcome {
    return fail('invalid-argument', `operations[${index}].${name} ${message}`, { argument: `operations[${index}].${name}`, ...details });
}

/** One parsed item as a model operation, or the argument error for a missing, misplaced or unknown field */
function toOperation(item: ModelItem, index: number): ModelOperation | ToolOutcome {
    if (item.op === 'remove') {
        const extra = (['type', 'default', 'required', 'validators'] as const).find((name) => item[name] !== undefined);
        return extra === undefined ? { op: 'remove', field: item.field } : misplaced(index, extra, 'is not allowed for remove');
    }
    if (item.type === undefined) return misplaced(index, 'type', `is required for set; one of: ${FIELD_TYPES.join(', ')}`, { allowed: FIELD_TYPES });
    const unknown = Object.keys(item.validators ?? {}).find((name) => !Object.hasOwn(VALIDATORS, name));
    if (unknown !== undefined) return misplaced(index, 'validators', `has no validator "${unknown}"; the validators are: ${VALIDATOR_NAMES.join(', ')}`, { allowed: VALIDATOR_NAMES });
    const declaration: JsonObject = {
        type: item.type,
        ...(item.default !== undefined && { default: item.default }),
        ...(item.required !== undefined && { required: item.required }),
        ...(item.validators !== undefined && { validators: item.validators })
    };
    return { op: 'set', field: item.field, declaration };
}

/** `ui_model_write`, when the server has parts */
export function createModelTools(useCases: Pick<UiBuilderUseCases, 'writeModel'>): readonly UiToolDefinition[] {
    const { writeModel } = useCases;
    if (writeModel === undefined) return [];
    return [
        {
            name: 'ui_model_write',
            description: `Build time: write a model, the typed fields of the records of its datasets and persona bindings. set adds a field or replaces its whole declaration ({ type, default?, required?, validators? }); remove takes a field out. Types: ${FIELD_TYPES.join(', ')}. Validators: ${VALIDATOR_NAMES.join(', ')}. A default must fit its type and its own validators. Leave expectedRevision out to create the model; pass it to change one. The model is checked and written as one change, or not at all. Returns { model, revision, created, warnings, datasetWarnings, readers }: datasetWarnings lists the datasets whose records no longer fit ({ dataset, keys, invalidCount }; fix them with ui_data_write), readers the apps and logic modules whose paths read a removed field ({ kind, name, paths }), and warnings the apps that now have errors.`,
            inputSchema: MODEL_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = MODEL_WRITE.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { model, expectedRevision } = parsed.value;
                const operations: ModelOperation[] = [];
                for (const [index, item] of parsed.value.operations.entries()) {
                    const converted = toOperation(item, index);
                    if (!('op' in converted)) return converted;
                    operations.push(converted);
                }
                const result = await writeModel.execute({ model, operations, ...(expectedRevision !== undefined && { expectedRevision }) });
                switch (result.kind) {
                    case 'written':
                        return succeed({
                            model,
                            revision: result.revision,
                            created: result.created,
                            warnings: result.warnings,
                            ...(result.moreApps > 0 && { moreApps: result.moreApps }),
                            datasetWarnings: result.datasetWarnings,
                            readers: result.readers
                        });
                    case 'invalid-name':
                        return fail('invalid-name', result.reason, { argument: 'model' });
                    case 'duplicate-name':
                        return fail('duplicate-name', `A model named "${model}" already exists; read it with ui_get and pass expectedRevision to change it`, { argument: 'model' });
                    case 'not-found':
                        return fail('not-found', `No model named "${model}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; leave expectedRevision out to create it'}`, {
                            argument: 'model',
                            nearest: result.nearest
                        });
                    case 'conflict':
                        return fail('conflict', `The model is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_get; nothing was written`, {
                            currentRevision: result.currentRevision
                        });
                    case 'invalid-operation':
                        return fail('invalid-operation', `Operation ${result.index} could not be applied: ${result.error.message}`, { index: result.index, errors: [result.error] });
                    case 'invalid':
                        return fail('invalid-model', 'The model has blocking errors; nothing was written. Each error names its path', { errors: result.errors });
                }
            }
        }
    ];
}
