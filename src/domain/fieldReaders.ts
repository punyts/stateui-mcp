/** One record segment of a data path: a record key, a `{capture}` or `*` */
const RECORD = String.raw`(?:[A-Za-z0-9_-]+|\{[A-Za-z_][A-Za-z0-9_]*\}|\*)`;

/** True for a binding or field name that may stand in a pattern as it is (a key name) */
function isKeyName(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function collect(value: unknown, into: string[]): void {
    if (typeof value === 'string') into.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item, into);
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collect(item, into);
}

/**
 * The paths in a part body (an app or a logic module) that read one of `fields` of the records bound as `bindings`:
 * `$.data.{binding}.{record}.{field}` and anything below it, where the record is a key, a `{capture}` or `*`, wherever
 * the path stands in a string (a link, a trigger, a command, a `{{ }}` expression). Sorted and without repeats. A row
 * template's `$row.{field}` is not found: which list a row belongs to is not in the text
 */
export function fieldReaders(body: unknown, bindings: readonly string[], fields: readonly string[]): string[] {
    const names = bindings.filter(isKeyName);
    const wanted = fields.filter(isKeyName);
    if (names.length === 0 || wanted.length === 0) return [];
    const pattern = new RegExp(String.raw`\$\.data\.(?:${names.join('|')})\.${RECORD}\.(?:${wanted.join('|')})(?:\.${RECORD})*(?![A-Za-z0-9_-])`, 'g');
    const strings: string[] = [];
    collect(body, strings);
    const found = new Set<string>();
    for (const text of strings) for (const match of text.matchAll(pattern)) found.add(match[0]);
    return [...found].sort();
}
