import { compilePattern, patternContains, patternCovers, type PathPattern } from '@punyts/state';
import type { NewPermission, PermissionEntry, PermissionRight } from './ports/PermissionStore.js';

/** The most entries in one chain, the owner's first */
export const MAX_PERMISSION_DEPTH = 8;

export const PERMISSION_RIGHTS: readonly PermissionRight[] = ['read', 'request', 'write', 'share'];

/** Why an entry was not made */
export class PermissionRefused extends Error {
    constructor(
        readonly reason: 'invalid' | 'not-found' | 'too-deep' | 'wider',
        message: string
    ) {
        super(message);
        this.name = 'PermissionRefused';
    }
}

/** A pattern of an entry read: `$` is the whole tree; undefined when it is not a pattern */
export function permissionPattern(source: string): PathPattern | undefined {
    return source === '$' ? { source, steps: [] } : compilePattern(source);
}

/** The entry and the entries it was passed on from, itself first; stops at a missing parent */
export function chainOf(entry: PermissionEntry, byId: ReadonlyMap<string, PermissionEntry>): PermissionEntry[] {
    const chain = [entry];
    for (let at = entry; at.parent !== undefined && chain.length <= MAX_PERMISSION_DEPTH; ) {
        const parent = byId.get(at.parent);
        if (parent === undefined) return [...chain, { ...at, revokedAt: at.createdAt }];
        chain.push(parent);
        at = parent;
    }
    return chain;
}

/** Whether an entry holds now: neither it nor any entry above it revoked or ended */
export function entryHolds(entry: PermissionEntry, byId: ReadonlyMap<string, PermissionEntry>, now: Date): boolean {
    return chainOf(entry, byId).every((each) => each.revokedAt === undefined && (each.until === undefined || Date.parse(each.until) > now.getTime()));
}

/** Whether a holder's subjects may use a right at a path of an owner, given the owner's entries */
export function allowsIn(entries: readonly PermissionEntry[], subjects: readonly string[], owner: string, path: string, right: PermissionRight, now: Date): boolean {
    if (subjects.includes(`owner:${owner}`)) return true;
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    return entries.some((entry) => {
        const pattern = permissionPattern(entry.pattern);
        return entry.owner === owner && subjects.includes(entry.subject) && entry.rights.includes(right) && pattern !== undefined && patternCovers(pattern, path) && entryHolds(entry, byId, now);
    });
}

/** Checks a new entry against the owner's entries; answers its end, cut to its parent's. Throws `PermissionRefused` */
export function checkNewEntry(entry: NewPermission, entries: readonly PermissionEntry[], now: Date): string | undefined {
    const pattern = permissionPattern(entry.pattern);
    if (pattern === undefined) throw new PermissionRefused('invalid', 'Not a path pattern.');
    if (entry.rights.length === 0 || !entry.rights.every((right) => PERMISSION_RIGHTS.includes(right))) throw new PermissionRefused('invalid', 'Rights are read, request, write and share.');
    if (entry.parent === undefined) return entry.until;
    const byId = new Map(entries.map((each) => [each.id, each] as const));
    const parent = byId.get(entry.parent);
    if (parent === undefined || !entryHolds(parent, byId, now)) throw new PermissionRefused('not-found', 'That entry is not there any more.');
    if (chainOf(parent, byId).length >= MAX_PERMISSION_DEPTH) throw new PermissionRefused('too-deep', 'That entry was passed on too many times.');
    const from = permissionPattern(parent.pattern);
    if (parent.owner !== entry.owner || from === undefined || !patternContains(from, pattern) || !entry.rights.every((right) => parent.rights.includes(right))) {
        throw new PermissionRefused('wider', 'An entry passed on can only be narrower than the one it came from.');
    }
    if (parent.until === undefined) return entry.until;
    return entry.until === undefined || Date.parse(parent.until) < Date.parse(entry.until) ? parent.until : entry.until;
}

/** The ids of an entry and every entry passed on from it that are still live */
export function passedOnFrom(id: string, entries: readonly PermissionEntry[]): string[] {
    const found = [id];
    for (let index = 0; index < found.length; index++) {
        for (const entry of entries) if (entry.parent === found[index] && entry.revokedAt === undefined) found.push(entry.id);
    }
    return found;
}
