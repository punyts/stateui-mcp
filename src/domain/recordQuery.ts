/**
 * Filtering, sorting and windowing records with the expression language of the logic `query` command. The evaluator
 * lives in `@punyts/stateui-app/core`, so a dataset query on the server and a `query` in an app agree
 */
export { LogicError, queryRecords } from '@punyts/stateui-app/core';
export type { RecordQuery, RecordQueryResult } from '@punyts/stateui-app/core';
