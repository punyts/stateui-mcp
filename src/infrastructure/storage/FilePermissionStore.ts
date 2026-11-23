import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allowsIn, chainOf, checkNewEntry, passedOnFrom } from '../../application/permissions.js';
import type { NewPermission, PermissionEntry, PermissionRight, PermissionStore } from '../../application/ports/PermissionStore.js';
import { writeFileAtomic } from './atomicFile.js';
import { KeyedLock } from './KeyedLock.js';

const OWNER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The permission entries of a local server (docs/design/statenet-permissions.md, "Storage"): one JSON file per owner,
 * `<dir>/<owner>.json`, an array of entries, oldest first, rewritten whole and atomically on each change
 */
export class FilePermissionStore implements PermissionStore {
    private readonly lock = new KeyedLock();

    constructor(
        private readonly dir: string,
        private readonly now: () => Date = () => new Date()
    ) {}

    async list(owner: string): Promise<readonly PermissionEntry[]> {
        return this.read(owner);
    }

    async make(entry: NewPermission): Promise<PermissionEntry> {
        return this.lock.run(entry.owner, async () => {
            const entries = await this.read(entry.owner);
            const now = this.now();
            const until = checkNewEntry(entry, entries, now);
            const made: PermissionEntry = {
                id: randomUUID(),
                owner: entry.owner,
                pattern: entry.pattern,
                subject: entry.subject,
                rights: [...entry.rights],
                ...(entry.parent !== undefined && { parent: entry.parent }),
                ...(entry.by !== undefined && { by: entry.by }),
                createdAt: now.toISOString(),
                ...(until !== undefined && { until })
            };
            await this.write(entry.owner, [...entries, made]);
            return made;
        });
    }

    async revoke(owner: string, id: string, by: string): Promise<readonly string[]> {
        return this.lock.run(owner, async () => {
            const entries = await this.read(owner);
            if (!entries.some((entry) => entry.id === id && entry.revokedAt === undefined)) return [];
            const ids = new Set(passedOnFrom(id, entries));
            const revokedAt = this.now().toISOString();
            await this.write(
                owner,
                entries.map((entry) => (ids.has(entry.id) ? { ...entry, revokedAt, revokedBy: by } : entry))
            );
            return [...ids];
        });
    }

    async allows(subjects: readonly string[], owner: string, path: string, right: PermissionRight): Promise<boolean> {
        if (subjects.includes(`owner:${owner}`)) return true;
        return allowsIn(await this.read(owner), subjects, owner, path, right, this.now());
    }

    async revoked(owner: string, ids: readonly string[]): Promise<ReadonlySet<string>> {
        const entries = await this.read(owner);
        const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
        return new Set(
            ids.filter((id) => {
                const entry = byId.get(id);
                return entry !== undefined && chainOf(entry, byId).some((each) => each.revokedAt !== undefined);
            })
        );
    }

    private file(owner: string): string {
        if (!OWNER_NAME.test(owner)) throw new Error('An owner is a name of letters, digits, _ and -');
        return join(this.dir, `${owner}.json`);
    }

    private async read(owner: string): Promise<PermissionEntry[]> {
        try {
            return JSON.parse(await readFile(this.file(owner), 'utf8')) as PermissionEntry[];
        } catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
            throw error;
        }
    }

    private async write(owner: string, entries: readonly PermissionEntry[]): Promise<void> {
        await writeFileAtomic(this.file(owner), `${JSON.stringify(entries, null, 2)}\n`);
    }
}
