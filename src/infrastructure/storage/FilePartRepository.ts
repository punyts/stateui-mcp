import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import type {
    CreateUiPartInput,
    CreateUiPartResult,
    UiPartDeleteResult,
    UiPartRenameResult,
    UiPartRepository,
    UiPartRewrite,
    UiPartRewritten,
    UiPartSummary,
    UiPartWriteResult
} from '../../application/ports/UiPartRepository.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { PART_KINDS } from '../../domain/partName.js';
import type { PartKind } from '../../domain/partName.js';
import { isRevisionCurrent } from '../../domain/revision.js';
import { PART_BODY_PROBLEM, createUiPart, isPartBody, isPartKind, partInputProblem, partNameProblem, renameUiPart, reviseUiPart } from '../../domain/UiPart.js';
import type { UiPart, UiPartBodies } from '../../domain/UiPart.js';
import { isMissing, readJson, writeJsonAtomic } from './atomicFile.js';
import type { KeyedLock } from './KeyedLock.js';
import { isPartId } from './PartFolders.js';
import type { PartFolders } from './PartFolders.js';

/** `<kind>/<id>.json`: one part. The body is written with `JSON.stringify` and read with `JSON.parse`, so key order survives */
interface PartFile {
    readonly id: string;
    readonly kind: PartKind;
    readonly name: string;
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly body: object;
}

const NAMES_LOCK = 'names.json';
/** Taken first by every rename, so two renames never wait on each other's part locks */
const RENAME_LOCK = '*rename';

/** One file of a rename: the part file as it is to be */
interface JournalFile {
    readonly kind: PartKind;
    readonly id: string;
    readonly file: PartFile;
}

/** `rename.pending.json`: every part file a rename writes, with its new content */
interface RenameJournal {
    readonly files: readonly JournalFile[];
}

function isRenameJournal(value: unknown): value is RenameJournal {
    if (!isJsonObject(value) || !Array.isArray(value['files'])) return false;
    return value['files'].every(
        (entry: unknown) =>
            isJsonObject(entry) &&
            isPartKind(entry['kind']) &&
            typeof entry['id'] === 'string' &&
            isPartId(entry['id']) &&
            isPartFile(entry['file']) &&
            entry['file'].kind === entry['kind'] &&
            entry['file'].id === entry['id']
    );
}

/** Runs `task` holding every lock of `keys`, taken in the order given */
function withLocks<T>(lock: KeyedLock, keys: readonly string[], task: () => Promise<T>): Promise<T> {
    return keys.reduceRight<() => Promise<T>>((inner, key) => () => lock.run(key, inner), task)();
}

function isPartFile(value: unknown): value is PartFile {
    return (
        isJsonObject(value) &&
        typeof value['id'] === 'string' &&
        isPartKind(value['kind']) &&
        typeof value['name'] === 'string' &&
        typeof value['revision'] === 'number' &&
        typeof value['createdAt'] === 'string' &&
        typeof value['updatedAt'] === 'string' &&
        isPartBody(value['body'])
    );
}

function toFile(part: UiPart): PartFile {
    return {
        id: part.id,
        kind: part.kind,
        name: part.name,
        revision: part.revision,
        createdAt: part.createdAt.toISOString(),
        updatedAt: part.updatedAt.toISOString(),
        body: part.body
    };
}

function toPart<K extends PartKind>(file: PartFile): UiPart<K> {
    return {
        id: file.id,
        kind: file.kind as K,
        name: file.name,
        revision: file.revision,
        body: file.body as UiPartBodies[K],
        createdAt: new Date(file.createdAt),
        updatedAt: new Date(file.updatedAt)
    };
}

export interface FilePartRepositoryOptions {
    readonly now?: () => Date;
    readonly newId?: () => string;
    /** Called after each file a rename writes (the journal, each part file, `names.json`); tests throw here to stop a rename halfway */
    readonly afterRenameWrite?: (path: string) => void;
}

/**
 * The owner's parts as files (see `PartFolders`): `<kind>/<id>.json` per part and `names.json` as the index of names.
 * Every write is a temporary file renamed into place. The part file is the truth: it is written first and `names.json`
 * after it, and at the first call the names are read from the part files and `names.json` is rewritten when it is
 * missing or disagrees (a crash between the two writes leaves it behind).
 *
 * A rename that rewrites other parts (O2.5) first writes `rename.pending.json`, every part file it will write with its
 * new content, then the part files and `names.json`, and removes the journal last. A journal that is still there was
 * stopped halfway: `recover` (also run before the first call reads the names) writes the files that differ from it and
 * removes it. A rename of a part that nothing names writes that one file and `names.json`, with no journal.
 *
 * Locks (`KeyedLock`, one process): `{kind}/{name}` for a write, and `{kind}/*names` before it for create, rename and
 * delete, so two creates of one name cannot both win and a write queued behind a rename finds the name gone. A rename
 * takes `*rename` first and then the name locks of every part it writes, in order
 */
export class FilePartRepository implements UiPartRepository {
    private loading: Promise<Map<PartKind, Map<string, string>>> | undefined;
    private readonly now: () => Date;
    private readonly newId: () => string;
    private readonly afterRenameWrite: (path: string) => void;

    constructor(
        private readonly folders: PartFolders,
        private readonly lock: KeyedLock,
        options: FilePartRepositoryOptions = {}
    ) {
        this.now = options.now ?? (() => new Date());
        this.newId = options.newId ?? randomUUID;
        this.afterRenameWrite = options.afterRenameWrite ?? (() => undefined);
    }

    async create<K extends PartKind>(input: CreateUiPartInput<K>): Promise<CreateUiPartResult<K>> {
        const problem = partInputProblem(input.kind, input.name, input.body);
        if (problem !== undefined) return { kind: 'invalid', reason: problem };
        const names = (await this.names()).get(input.kind) as Map<string, string>;
        return this.lock.run(`${input.kind}/*names`, async (): Promise<CreateUiPartResult<K>> => {
            if (names.has(input.name)) return { kind: 'duplicate-name' };
            const part = createUiPart({ id: this.newId(), kind: input.kind, name: input.name, body: input.body, now: this.now() });
            await writeJsonAtomic(this.folders.partFile(part.kind, part.id), toFile(part as UiPart));
            names.set(part.name, part.id);
            await this.saveNames();
            return { kind: 'created', part: { ...part, body: structuredClone(part.body) } };
        });
    }

    async findByName<K extends PartKind>(kind: K, name: string): Promise<UiPart<K> | undefined> {
        if (!isPartKind(kind)) return undefined;
        const id = (await this.names()).get(kind)?.get(name);
        return id === undefined ? undefined : this.read<K>(kind, id);
    }

    async findById<K extends PartKind>(kind: K, id: string): Promise<UiPart<K> | undefined> {
        if (!isPartKind(kind) || !isPartId(id)) return undefined;
        return this.read<K>(kind, id);
    }

    async list(kind: PartKind): Promise<readonly UiPartSummary[]> {
        const names = (await this.names()).get(kind);
        if (names === undefined) return [];
        const summaries: UiPartSummary[] = [];
        for (const [name, id] of [...names].sort(([a], [b]) => (a < b ? -1 : 1))) {
            const part = await this.read(kind, id);
            if (part !== undefined) summaries.push({ id, kind, name, revision: part.revision, updatedAt: part.updatedAt });
        }
        return summaries;
    }

    async write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], expectedRevision: number): Promise<UiPartWriteResult> {
        if (!isPartBody(body)) return { kind: 'invalid', reason: PART_BODY_PROBLEM };
        if (!isPartKind(kind)) return { kind: 'not-found' };
        const names = (await this.names()).get(kind) as Map<string, string>;
        return this.lock.run(`${kind}/${name}`, async (): Promise<UiPartWriteResult> => {
            const id = names.get(name);
            const part = id === undefined ? undefined : await this.read<K>(kind, id);
            if (part === undefined) return { kind: 'not-found' };
            if (!isRevisionCurrent(part.revision, expectedRevision)) return { kind: 'conflict', currentRevision: part.revision };
            const written = reviseUiPart(part, body, this.now());
            await writeJsonAtomic(this.folders.partFile(kind, written.id), toFile(written as UiPart));
            return { kind: 'written', revision: written.revision };
        });
    }

    async delete(kind: PartKind, name: string, expectedRevision: number): Promise<UiPartDeleteResult> {
        if (!isPartKind(kind)) return { kind: 'not-found' };
        const names = (await this.names()).get(kind) as Map<string, string>;
        return this.lock.run(`${kind}/*names`, () =>
            this.lock.run(`${kind}/${name}`, async (): Promise<UiPartDeleteResult> => {
                const id = names.get(name);
                const part = id === undefined ? undefined : await this.read(kind, id);
                if (part === undefined) return { kind: 'not-found' };
                if (!isRevisionCurrent(part.revision, expectedRevision)) return { kind: 'conflict', currentRevision: part.revision };
                await rm(this.folders.partFile(kind, part.id), { force: true });
                names.delete(name);
                await this.saveNames();
                return { kind: 'deleted' };
            })
        );
    }

    async rename(kind: PartKind, from: string, to: string, rewrites: readonly UiPartRewrite[] = []): Promise<UiPartRenameResult> {
        const problem = partNameProblem(to);
        if (problem !== undefined) return { kind: 'invalid', reason: problem };
        if (!isPartKind(kind)) return { kind: 'not-found' };
        for (const rewrite of rewrites) {
            if (!isPartKind(rewrite.kind)) return { kind: 'not-found' };
            if (!isPartBody(rewrite.body)) return { kind: 'invalid', reason: PART_BODY_PROBLEM };
        }
        const index = await this.names();
        const names = index.get(kind) as Map<string, string>;
        const partKeys = [...new Set([`${kind}/${from}`, ...rewrites.map((rewrite) => `${rewrite.kind}/${rewrite.name}`)])].sort();
        return withLocks(this.lock, [RENAME_LOCK, `${kind}/*names`, ...partKeys], async (): Promise<UiPartRenameResult> => {
            const id = names.get(from);
            const part = id === undefined ? undefined : await this.read(kind, id);
            if (part === undefined) return { kind: 'not-found' };
            if (names.has(to)) return { kind: 'duplicate-name' };
            const now = this.now();
            let renamedBody = part.body;
            const revised: UiPart[] = [];
            for (const rewrite of rewrites) {
                const self = rewrite.kind === kind && rewrite.name === from;
                const rewriteId = index.get(rewrite.kind)?.get(rewrite.name);
                const current = self ? part : rewriteId === undefined ? undefined : await this.read(rewrite.kind, rewriteId);
                if (current === undefined || !isRevisionCurrent(current.revision, rewrite.expectedRevision)) {
                    return { kind: 'conflict', part: { kind: rewrite.kind, name: rewrite.name }, currentRevision: current?.revision ?? 0 };
                }
                if (self) renamedBody = rewrite.body as UiPartBodies[PartKind];
                else revised.push(reviseUiPart(current, rewrite.body as UiPartBodies[PartKind], now));
            }
            const renamed = renameUiPart({ ...part, body: renamedBody }, to, now);
            const files = [renamed, ...revised].map((written) => ({ kind: written.kind, id: written.id, file: toFile(written) }));
            await this.apply(files, () => {
                names.delete(from);
                names.set(to, renamed.id);
            });
            const rewritten: UiPartRewritten[] = revised.map(({ kind: of, name, revision }) => ({ kind: of, name, revision }));
            return { kind: 'renamed', revision: renamed.revision, rewritten };
        });
    }

    /**
     * Finishes a rename that was stopped halfway: writes each file of `rename.pending.json` whose content differs, removes
     * the journal, then reads the names from the part files again and rewrites `names.json`. True when there was a
     * journal. Running it again changes nothing
     */
    async recover(): Promise<boolean> {
        const finished = await this.lock.run(RENAME_LOCK, () => this.finishJournal());
        if (finished) {
            // the names are read from the part files again, which rewrites names.json when it disagrees
            this.loading = undefined;
            await this.names();
        }
        return finished;
    }

    /** Writes the part files of a rename (through the journal when there are several) and `names.json` */
    private async apply(files: readonly JournalFile[], renameInIndex: () => void): Promise<void> {
        const journal = this.folders.renameJournal();
        if (files.length > 1) {
            await writeJsonAtomic(journal, { files } satisfies RenameJournal);
            this.afterRenameWrite(journal);
        }
        for (const { kind, id, file } of files) {
            const path = this.folders.partFile(kind, id);
            await writeJsonAtomic(path, file);
            this.afterRenameWrite(path);
        }
        renameInIndex();
        await this.saveNames();
        this.afterRenameWrite(this.folders.namesFile());
        if (files.length > 1) await rm(journal, { force: true });
    }

    private async finishJournal(): Promise<boolean> {
        const journal = await readJson(this.folders.renameJournal());
        if (journal === undefined) return false;
        if (!isRenameJournal(journal)) throw new Error('rename.pending.json is damaged');
        for (const { kind, id, file } of journal.files) {
            const path = this.folders.partFile(kind, id);
            const current = await readJson(path);
            if (JSON.stringify(current) !== JSON.stringify(file)) await writeJsonAtomic(path, file);
        }
        await rm(this.folders.renameJournal(), { force: true });
        return true;
    }

    private async read<K extends PartKind>(kind: K, id: string): Promise<UiPart<K> | undefined> {
        const parsed = await readJson(this.folders.partFile(kind, id));
        if (parsed === undefined) return undefined;
        if (!isPartFile(parsed) || parsed.kind !== kind || parsed.id !== id.toLowerCase()) throw new Error(`${kind}/${id}.json is damaged`);
        return toPart<K>(parsed);
    }

    /** The names of every kind, read from the part files at the first call */
    private names(): Promise<Map<PartKind, Map<string, string>>> {
        this.loading ??= this.load().catch((error: unknown) => {
            this.loading = undefined;
            throw error;
        });
        return this.loading;
    }

    private async load(): Promise<Map<PartKind, Map<string, string>>> {
        await this.lock.run(RENAME_LOCK, () => this.finishJournal());
        const index = new Map<PartKind, Map<string, string>>();
        for (const kind of PART_KINDS) {
            const names = new Map<string, string>();
            index.set(kind, names);
            let entries: string[];
            try {
                entries = await readdir(this.folders.kindDir(kind));
            } catch (error) {
                if (isMissing(error)) continue;
                throw error;
            }
            for (const entry of entries.sort()) {
                const id = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : '';
                if (!isPartId(id)) continue;
                const part = await this.read(kind, id);
                if (part === undefined) continue;
                if (names.has(part.name)) throw new Error(`Two ${kind} parts are named "${part.name}": ${names.get(part.name)} and ${part.id}`);
                names.set(part.name, part.id);
            }
        }
        const stored = await readJson(this.folders.namesFile());
        if (JSON.stringify(stored) !== JSON.stringify(this.namesSnapshot(index))) {
            await this.lock.run(NAMES_LOCK, () => writeJsonAtomic(this.folders.namesFile(), this.namesSnapshot(index)));
        }
        return index;
    }

    /** `names.json` as it should be: every kind, names in order */
    private namesSnapshot(index: Map<PartKind, Map<string, string>>): Record<string, Record<string, string>> {
        const snapshot: Record<string, Record<string, string>> = {};
        for (const kind of PART_KINDS) {
            snapshot[kind] = Object.fromEntries([...(index.get(kind) ?? [])].sort(([a], [b]) => (a < b ? -1 : 1)));
        }
        return snapshot;
    }

    /** Rewrites `names.json` from the index as it is when the write's turn comes, so a slow write never lands an older index */
    private async saveNames(): Promise<void> {
        const index = await this.names();
        await this.lock.run(NAMES_LOCK, () => writeJsonAtomic(this.folders.namesFile(), this.namesSnapshot(index)));
    }
}
