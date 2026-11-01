/** The revision of an app when it is created */
export const INITIAL_REVISION = 1;

export function isRevision(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= INITIAL_REVISION;
}

/** The revision after one committed write: always the current one plus one */
export function nextRevision(current: number): number {
    if (!isRevision(current)) {
        throw new RangeError(`Invalid revision: ${String(current)}`);
    }
    return current + 1;
}

/**
 * Whether a write may commit. An absent `expectedRevision` skips the check (the caller chose last-writer-wins);
 * a present one must equal the stored revision, so a write never overwrites edits the caller has not seen
 */
export function isRevisionCurrent(current: number, expected: number | undefined): boolean {
    return expected === undefined || expected === current;
}
