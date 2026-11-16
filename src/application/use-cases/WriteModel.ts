import { fieldReaders } from '../../domain/fieldReaders.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { checkOperationLimit } from '../../domain/limits.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { UsageSource } from '../UsageIndex.js';
import type { AppWarning, DatasetWarning, WritePart } from './WritePart.js';

type ModelBody = UiPartBodies['models'];

/** A change to a model: a field's whole declaration set (added or replaced), or a field removed */
export type ModelOperation = { readonly op: 'set'; readonly field: string; readonly declaration: JsonObject } | { readonly op: 'remove'; readonly field: string };

export interface WriteModelInput {
    readonly model: string;
    /** Absent: the first write, which creates the model. Present: the revision the caller read */
    readonly expectedRevision?: number;
    readonly operations: readonly ModelOperation[];
}

/** An app or a logic module whose paths read a field the write removed */
export interface FieldReader {
    readonly kind: 'apps' | 'logic';
    readonly name: string;
    /** The paths that read a removed field, such as `$.data.products.{id}.price` */
    readonly paths: readonly string[];
}

export type WriteModelResult =
    | {
          readonly kind: 'written';
          readonly created: boolean;
          readonly revision: number;
          /** The apps the write leaves with errors, at most `MAX_WARNED_APPS` */
          readonly warnings: readonly AppWarning[];
          readonly moreApps: number;
          /** The datasets of the model whose records no longer fit, with the first invalid record keys */
          readonly datasetWarnings: readonly DatasetWarning[];
          /** The apps and modules whose paths read a removed field */
          readonly readers: readonly FieldReader[];
      }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'invalid-operation'; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

function failure(index: number, message: string, statePath: string): WriteModelResult {
    return { kind: 'invalid-operation', index, error: { code: 'SUI-DOC-PATH', message, statePath } };
}

/** The bindings of an app's `uses.data` and a module's `needs` that hold the records of `model` */
async function bindingsOf(parts: Pick<UiPartRepository, 'findByName'>, kind: 'apps' | 'logic', body: unknown, model: string): Promise<string[]> {
    const source = isJsonObject(body) ? body : {};
    const holder = kind === 'logic' ? source['needs'] : isJsonObject(source['uses']) ? source['uses']['data'] : undefined;
    const bindings: string[] = [];
    for (const [name, binding] of Object.entries(isJsonObject(holder) ? holder : {})) {
        if (!isJsonObject(binding)) continue;
        if (binding['model'] === model) bindings.push(name);
        else if (typeof binding['dataset'] === 'string' && (await parts.findByName('data', binding['dataset']))?.body.model === model) bindings.push(name);
    }
    return bindings;
}

/**
 * Writes a model field by field: a field's whole declaration (`type`, `default`, `required`, `validators`) set, or a field
 * removed. The first write creates the model. The model is checked by the library's reader (closed types and validators,
 * a default that fits its type and validators) and written through `WritePart`, which reports the apps it breaks and the
 * datasets whose records no longer fit; for removed fields the apps and modules whose paths read them are listed too
 */
export class WriteModel {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly usage: UsageSource,
        private readonly writePart: WritePart,
        private readonly log: UseCaseReport
    ) {}

    async execute(input: WriteModelInput): Promise<WriteModelResult> {
        const result = await this.write(input);
        this.log.info('Model write', {
            operationCount: input.operations.length,
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision, created: result.created, readers: result.readers.length, brokenDatasets: result.datasetWarnings.length })
        });
        return result;
    }

    private async write(input: WriteModelInput): Promise<WriteModelResult> {
        const { model, operations, expectedRevision } = input;
        if (operations.length === 0) return { kind: 'invalid', errors: [{ code: 'SUI-DOC-OPERATION', message: 'A write needs at least one operation', statePath: '$' }] };
        const overLimit = checkOperationLimit(operations.length);
        if (overLimit !== undefined) return { kind: 'invalid', errors: [overLimit] };

        let fields: JsonObject;
        if (expectedRevision === undefined) {
            const problem = partNameProblem(model);
            if (problem !== undefined) return { kind: 'invalid-name', reason: problem };
            if ((await this.parts.findByName('models', model)) !== undefined) return { kind: 'duplicate-name' };
            fields = {};
        } else {
            const part = await this.parts.findByName('models', model);
            if (part === undefined) return { kind: 'not-found', nearest: nearestNames(model, (await this.parts.list('models')).map((summary) => summary.name)) };
            if (part.revision !== expectedRevision) return { kind: 'conflict', currentRevision: part.revision };
            fields = structuredClone(part.body.fields) as unknown as JsonObject;
        }

        const removed = new Set<string>();
        for (const [index, operation] of operations.entries()) {
            if (operation.op === 'set') {
                fields = { ...fields, [operation.field]: operation.declaration };
                removed.delete(operation.field);
                continue;
            }
            if (!Object.hasOwn(fields, operation.field)) {
                const nearest = nearestNames(operation.field, Object.keys(fields));
                return failure(index, `The model has no field "${operation.field}"${nearest.length > 0 ? `; nearest: ${nearest.join(', ')}` : ''}`, `$.fields.${operation.field}`);
            }
            const { [operation.field]: _removed, ...rest } = fields;
            fields = rest;
            removed.add(operation.field);
        }

        const body = { fields } as unknown as ModelBody;
        const stored = await this.writePart.execute({ kind: 'models', name: model, body, ...(expectedRevision !== undefined && { expectedRevision }) });
        switch (stored.kind) {
            case 'written':
                return {
                    kind: 'written',
                    created: expectedRevision === undefined,
                    revision: stored.revision,
                    warnings: stored.warnings,
                    moreApps: stored.moreApps,
                    datasetWarnings: stored.datasetWarnings,
                    readers: await this.readers(model, [...removed])
                };
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            default:
                return stored;
        }
    }

    /** The modules that need the model and the apps that reach it, whose paths read a removed field */
    private async readers(model: string, removed: readonly string[]): Promise<FieldReader[]> {
        if (removed.length === 0) return [];
        const index = await this.usage.usage();
        const readers: FieldReader[] = [];
        const candidates: { kind: 'apps' | 'logic'; name: string }[] = [
            ...index
                .usedBy('models', model)
                .filter((user) => user.kind === 'logic')
                .map((user) => ({ kind: 'logic' as const, name: user.name })),
            ...index.appsUsing('models', model).map((name) => ({ kind: 'apps' as const, name }))
        ];
        for (const { kind, name } of candidates) {
            const part = await this.parts.findByName(kind, name);
            if (part === undefined) continue;
            const paths = fieldReaders(part.body, await bindingsOf(this.parts, kind, part.body, model), removed);
            if (paths.length > 0) readers.push({ kind, name, paths });
        }
        return readers;
    }
}
