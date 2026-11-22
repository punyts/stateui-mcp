/** A duration in milliseconds since `start` (from `performance.now()`), rounded to a tenth, for a report */
export function msSince(start: number): number {
    return Math.round((performance.now() - start) * 10) / 10;
}
