import { applyOperation } from '../../domain/documentOperations.js';
import type { WriteOperation } from '../../domain/documentOperations.js';
import { parseDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { isBlockingError } from '../../domain/UiBuildError.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { loadPartSource } from '../partSource.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** A write without `expectedRevision` is applied again to the newest records this many times at most */
export const DATA_WRITE_ATTEMPTS = 5;

/** Adds a record under a new key: `r` and an id, so it is never integer-like */
export interface AddRecordOperation {
    readonly op: 'add';
    readonly value: JsonValue;
}

/**
 * One change to a dataset's records. Paths are relative to `records`: `p1` is a record, `p1.name` one of its fields.
 * `set`, `merge`, `remove` and `move` are the document operations (`documentOperations.ts`); `move` reorders a record
 * with `before` or `after`
 */
export type DataOperation = AddRecordOperation | WriteOperation;

export interface WriteDataInput {
    /** The dataset part's name */
    readonly name: string;
    readonly operations: readonly DataOperation[];
    /**
     * The revision the caller read. Absent: the operations are applied to the newest records, so writes to different
     * records never conflict
     */
    readonly expectedRevision?: number;
    /**
     * The model of a dataset the write creates: a missing dataset is created with it (the first write). For a dataset
     * that exists it must be the dataset's model, or be left out
     */
    readonly model?: string;
}

export type WriteDataResult =
    /** `added`: the keys `add` gave, in order; `created`: the write created the dataset */
    | { readonly kind: 'written'; readonly revision: number; readonly added: readonly string[]; readonly created: boolean }
    /** An operation that does not apply, or a record it leaves invalid (`$.records.{key}`, naming the field); nothing was written */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    /** No such dataset, and no `model` to create it with (or an `expectedRevision`); `nearest`: dataset names */
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    /** The dataset to create has a name that is not a slug */
    | { readonly kind: 'invalid-name'; readonly reason: string }
    /** The model to create the dataset with does not exist; `nearest`: model names */
    | { readonly kind: 'model-not-found'; readonly nearest: readonly string[] }
    /** The dataset exists with another model */
    | { readonly kind: 'model-mismatch'; readonly model: string };

const RECORD_ERROR = /^\$\.records\.([^.]+)/;

/** The records each operation changes, by key; `undefined` for an operation on the whole map */
function touchedKey(operation: DataOperation): string | undefined {
    const parsed = parseDocumentPath(operation.op === 'add' ? '' : operation.path);
    return parsed.ok ? parsed.path[0] : undefined;
}

/** The operation with its paths below `records` */
function underRecords(operation: WriteOperation): WriteOperation {
    const path = operation.path === '' ? 'records' : `records.${operation.path}`;
    if (operation.op !== 'move') return { ...operation, path };
    return { ...operation, path, ...(operation.to !== undefined && { to: operation.to === '' ? 'records' : `records.${operation.to}` }) };
}

/**
 * Changes the records of a dataset part with record operations, checks every record they touch against the dataset's
 * model (`checkRecord`, through the validator's dataset check) and writes the dataset one revision up, or nothing. A
 * record the write does not touch is not checked, so records left invalid by a model change do not block other edits.
 * Without `expectedRevision` a write that loses a race is applied again to the newest records
 */
export class WriteData {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly newId: () => string,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WriteDataInput): Promise<WriteDataResult> {
        let result: WriteDataResult = { kind: 'not-found', nearest: [] };
        for (let attempt = 1; attempt <= DATA_WRITE_ATTEMPTS; attempt++) {
            result = await this.attempt(input);
            if (result.kind !== 'conflict' || input.expectedRevision !== undefined) break;
        }
        this.report.info('Dataset write', {
            name: input.name,
            operations: input.operations.length,
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision, created: result.created }),
            ...(result.kind === 'invalid' && { errorCount: result.errors.length })
        });
        return result;
    }

    private async attempt(input: WriteDataInput): Promise<WriteDataResult> {
        const part = await this.parts.findByName('data', input.name);
        let body: JsonObject;
        let revision = 0;
        if (part === undefined) {
            if (input.model === undefined || input.expectedRevision !== undefined) return { kind: 'not-found', nearest: await this.nearest('data', input.name) };
            const problem = partNameProblem(input.name);
            if (problem !== undefined) return { kind: 'invalid-name', reason: problem };
            if ((await this.parts.findByName('models', input.model)) === undefined) return { kind: 'model-not-found', nearest: await this.nearest('models', input.model) };
            body = { model: input.model, records: {} };
        } else {
            const model = (part.body as unknown as JsonObject)['model'];
            if (input.model !== undefined && model !== input.model) return { kind: 'model-mismatch', model: String(model) };
            revision = input.expectedRevision ?? part.revision;
            if (revision !== part.revision) return { kind: 'conflict', currentRevision: part.revision };
            body = part.body as unknown as JsonObject;
        }
        let document: JsonObject = { records: isJsonObject(body['records']) ? body['records'] : {} };
        const added: string[] = [];
        const touched = new Set<string>();
        let whole = false;
        for (const operation of input.operations) {
            let write: WriteOperation;
            if (operation.op === 'add') {
                if (!isJsonObject(operation.value)) return { kind: 'invalid', errors: [{ code: 'SUI-DOC-OPERATION', message: 'add needs a record object as its value', statePath: '$.records' }] };
                const key = `r${this.newId()}`;
                added.push(key);
                touched.add(key);
                write = { op: 'set', path: `records.${key}`, value: operation.value };
            } else {
                const key = touchedKey(operation);
                if (key === undefined) whole = true;
                else touched.add(key);
                write = underRecords(operation);
            }
            const applied = applyOperation(document, write);
            if (!applied.ok) return { kind: 'invalid', errors: [applied.error] };
            document = applied.document;
        }

        const records = isJsonObject(document['records']) ? document['records'] : {};
        const next = { ...body, records } as unknown as UiPartBodies['data'];
        const errors = await this.recordErrors(input.name, next, whole ? undefined : touched);
        if (errors.length > 0) return { kind: 'invalid', errors };
        if (part === undefined) {
            const created = await this.parts.create({ kind: 'data', name: input.name, body: next });
            if (created.kind === 'created') return { kind: 'written', revision: created.part.revision, added, created: true };
            if (created.kind === 'invalid') return { kind: 'invalid', errors: [{ code: 'SUI-PART-SHAPE', message: created.reason }] };
            // Created by someone else meanwhile: without expectedRevision the write is tried again on that dataset
            return { kind: 'conflict', currentRevision: 1 };
        }
        const written = await this.parts.write('data', input.name, next, revision);
        if (written.kind === 'written') return { kind: 'written', revision: written.revision, added, created: false };
        if (written.kind === 'invalid') return { kind: 'invalid', errors: [{ code: 'SUI-PART-SHAPE', message: written.reason }] };
        if (written.kind === 'not-found') return { kind: 'not-found', nearest: [] };
        return written;
    }

    private async nearest(kind: 'data' | 'models', name: string): Promise<string[]> {
        return nearestNames(name, (await this.parts.list(kind)).map((summary) => summary.name));
    }

    /** The blocking errors of the dataset that concern the records in `touched` (all of them when undefined) or no record */
    private async recordErrors(name: string, body: UiPartBodies['data'], touched: ReadonlySet<string> | undefined): Promise<UiBuildError[]> {
        const model = (body as unknown as JsonObject)['model'];
        const source = await loadPartSource(this.parts, typeof model === 'string' ? [{ kind: 'models', name: model }] : []);
        return this.validator.validatePart('data', name, body, source).filter((error) => {
            if (!isBlockingError(error)) return false;
            const key = RECORD_ERROR.exec(error.statePath ?? '')?.[1];
            return key === undefined || touched === undefined || touched.has(key);
        });
    }
}
