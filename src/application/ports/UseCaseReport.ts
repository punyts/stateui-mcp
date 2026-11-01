import type { Report } from '@punyts/core';

/** The part of the `@punyts/core` reporter the use cases call. They report ids and counts, never document contents */
export type UseCaseReport = Pick<Report, 'info'>;
