/** How many names a "nearest" hint lists at most */
const MAX_SUGGESTIONS = 3;

function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
            row.push(Math.min(substitution, (previous[j] as number) + 1, (row[j - 1] as number) + 1));
        }
        previous = row;
    }
    return previous[b.length] as number;
}

/**
 * The known names closest to `name`, nearest first (ties in alphabetical order), at most three. Case is ignored.
 * A name is near when it differs by a third of its length or less (at least two edits), or when one contains the other
 */
export function nearestNames(name: string, known: Iterable<string>): string[] {
    const target = name.toLowerCase();
    const allowed = Math.max(2, Math.floor(target.length / 3));
    const scored: { name: string; distance: number }[] = [];
    for (const candidate of new Set(known)) {
        const lowered = candidate.toLowerCase();
        const contained = target.length >= 3 && (lowered.includes(target) || target.includes(lowered));
        const distance = editDistance(target, lowered);
        if (distance <= allowed || contained) scored.push({ name: candidate, distance });
    }
    scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
    return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.name);
}
