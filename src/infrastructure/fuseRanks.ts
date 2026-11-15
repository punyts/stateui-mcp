/** The constant of reciprocal rank fusion: large enough that one list's top entry does not drown the other list */
const RRF_K = 60;

/**
 * Lists of names, each best first, merged by reciprocal rank: a name scores `1 / (60 + rank)` in each list it is in,
 * and the scores add up. Ties keep the order of the first list, then of the next
 */
export function fuseRanks(lists: readonly (readonly string[])[]): string[] {
    const scores = new Map<string, number>();
    for (const list of lists) {
        list.forEach((name, rank) => scores.set(name, (scores.get(name) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}
