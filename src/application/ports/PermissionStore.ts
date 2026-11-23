/** What a permission entry lets its subject do (docs/design/statenet-permissions.md, "An entry") */
export type PermissionRight = 'read' | 'request' | 'write' | 'share';

/**
 * A right under one owner's tree: whoever the subject names may use the rights at every path the pattern covers, until
 * it ends or is revoked. An entry passed on from another (`parent`) is never wider than it. Entries are never deleted
 */
export interface PermissionEntry {
    readonly id: string;
    /** The owner whose tree it is in: the `$` of its pattern */
    readonly owner: string;
    /** A path pattern under the owner: `$`, `$.apps.a1`, `$.data.{set}`, `$.apps.*.files` */
    readonly pattern: string;
    /** Who holds it: `owner:<name>`, `members:<org>[.<role>]`, `group:<org>.<id>`, `link:<id>` or `everyone` */
    readonly subject: string;
    readonly rights: readonly PermissionRight[];
    /** The entry it was passed on from */
    readonly parent?: string;
    /** Who made it */
    readonly by?: string;
    /** ISO times */
    readonly createdAt: string;
    readonly until?: string;
    readonly revokedAt?: string;
    readonly revokedBy?: string;
}

/** What a new entry is: the store gives it its id and time, and cuts its end to its parent's */
export interface NewPermission {
    readonly owner: string;
    readonly pattern: string;
    readonly subject: string;
    readonly rights: readonly PermissionRight[];
    readonly parent?: string;
    readonly by?: string;
    readonly until?: string;
}

/**
 * Where an owner's permission entries are kept: a database's table on a server with many owners, a file per owner on
 * a local server. Every right is an entry; the owner holds everything under its own `$` without one
 */
export interface PermissionStore {
    /** Every entry under the owner, revoked ones included, oldest first */
    list(owner: string): Promise<readonly PermissionEntry[]>;
    /**
     * Makes an entry. One with a parent must be under the same owner as it, with a pattern the parent's contains, rights
     * among its rights, and every entry above it live, at most `MAX_PERMISSION_DEPTH` long. Throws `PermissionRefused`
     */
    make(entry: NewPermission): Promise<PermissionEntry>;
    /** Revokes an entry and every entry passed on from it; answers the ids it revoked (none when there is no such live entry) */
    revoke(owner: string, id: string, by: string): Promise<readonly string[]>;
    /** Whether any of a holder's subjects may use `right` at `path` of `owner`: `owner:<owner>` always, anyone else by a live entry that covers it */
    allows(subjects: readonly string[], owner: string, path: string, right: PermissionRight): Promise<boolean>;
    /** Which of these entries of the owner are revoked, or held through one that is */
    revoked(owner: string, ids: readonly string[]): Promise<ReadonlySet<string>>;
}
