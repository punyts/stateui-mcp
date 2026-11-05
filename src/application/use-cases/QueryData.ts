import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { queryRecords } from '../../domain/recordQuery.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface QueryDataInput {
    /** The dataset part's name */
    readonly name: string;
    /** An expression over `$record` and `$key`, as in the logic `query` command */
    readonly filter?: string;
    /** A field name (`-price` for descending) or `{ by, direction }` */
    readonly sort?: JsonValue;
    /** `{ first, count }`; without it, every record */
    readonly window?: JsonValue;
}

/** One record of the window, with its key */
export interface QueriedRecord {
    readonly key: string;
    readonly record: JsonValue;
}

export type QueryDataResult =
    /** `first`: the offset of the window; `total`: how many records matched before windowing */
    | { readonly kind: 'found'; readonly revision: number; readonly records: readonly QueriedRecord[]; readonly first: number; readonly total: number }
    /** A filter that does not evaluate */
    | { readonly kind: 'invalid'; readonly reason: string }
    | { readonly kind: 'not-found' };

/** Filters, sorts and windows the records of a dataset part with the evaluator of the logic `query` command */
export class QueryData {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: QueryDataInput): Promise<QueryDataResult> {
        const result = await this.query(input);
        this.report.info('Dataset query', {
            name: input.name,
            outcome: result.kind,
            ...(result.kind === 'found' && { returned: result.records.length, total: result.total })
        });
        return result;
    }

    private async query(input: QueryDataInput): Promise<QueryDataResult> {
        const part = await this.parts.findByName('data', input.name);
        if (part === undefined) return { kind: 'not-found' };
        const records = (part.body as unknown as JsonObject)['records'];
        try {
            const map = (isJsonObject(records) ? records : {}) as unknown as Parameters<typeof queryRecords>[0];
            const found = queryRecords(map, {
                ...(input.filter !== undefined && { filter: input.filter }),
                ...(input.sort !== undefined && { sort: input.sort }),
                ...(input.window !== undefined && { window: input.window })
            } as Parameters<typeof queryRecords>[1]);
            return {
                kind: 'found',
                revision: part.revision,
                records: found.rows.map(([key, record]) => ({ key, record: structuredClone(record) as JsonValue })),
                first: found.first,
                total: found.total
            };
        } catch (error) {
            return { kind: 'invalid', reason: `The query does not evaluate: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
}
