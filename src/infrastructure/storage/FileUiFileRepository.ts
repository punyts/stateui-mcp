import type { AddUiFileInput, AddUiFileResult, UiFileRepository, UiFileUsage } from '../../application/ports/UiFileRepository.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { MAX_BYTES_PER_APP, MAX_FILES_PER_APP } from '../../domain/UiFile.js';
import type { UiFile } from '../../domain/UiFile.js';
import type { AppFolders } from './AppFolders.js';
import { isAppId } from './AppFolders.js';
import { readJson, writeJsonAtomic } from './atomicFile.js';
import type { KeyedLock } from './KeyedLock.js';

/** One entry of `files.json`. Dates are ISO strings on disk */
interface FileEntry {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly type: string;
    readonly sha256: string;
    readonly createdAt: string;
}

function isFileEntry(value: unknown): value is FileEntry {
    return (
        isJsonObject(value) &&
        typeof value['id'] === 'string' &&
        typeof value['name'] === 'string' &&
        typeof value['size'] === 'number' &&
        typeof value['type'] === 'string' &&
        typeof value['sha256'] === 'string' &&
        typeof value['createdAt'] === 'string'
    );
}

/** The metadata of the files of an app, in `files.json` of the app folder. It shares the lock of the app with the app repository */
export class FileUiFileRepository implements UiFileRepository {
    constructor(
        private readonly folders: AppFolders,
        private readonly lock: KeyedLock,
        private readonly now: () => Date = () => new Date()
    ) {}

    async appExists(appId: string): Promise<boolean> {
        if (!isAppId(appId)) return false;
        return (await readJson(this.folders.appFile(appId))) !== undefined;
    }

    async usage(appId: string): Promise<UiFileUsage> {
        const entries = await this.readEntries(appId);
        return { count: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
    }

    async add(input: AddUiFileInput): Promise<AddUiFileResult> {
        if (!(await this.appExists(input.appId))) return { kind: 'not-found' };
        return this.lock.run(`files:${input.appId}`, async (): Promise<AddUiFileResult> => {
            const entries = await this.readEntries(input.appId);
            if (entries.length >= MAX_FILES_PER_APP) return { kind: 'quota', reason: 'files' };
            if (entries.reduce((sum, entry) => sum + entry.size, 0) + input.size > MAX_BYTES_PER_APP) return { kind: 'quota', reason: 'bytes' };
            const entry: FileEntry = {
                id: input.id,
                name: input.name,
                size: input.size,
                type: input.type,
                sha256: input.sha256,
                createdAt: this.now().toISOString()
            };
            await writeJsonAtomic(this.folders.filesIndex(input.appId), [...entries, entry]);
            return { kind: 'added', file: this.toFile(input.appId, entry) };
        });
    }

    async findById(appId: string, fileId: string): Promise<UiFile | undefined> {
        const entry = (await this.readEntries(appId)).find((candidate) => candidate.id === fileId);
        return entry === undefined ? undefined : this.toFile(appId, entry);
    }

    async list(appId: string): Promise<readonly UiFile[]> {
        const entries = await this.readEntries(appId);
        return entries.map((entry) => this.toFile(appId, entry)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    async findOlderThan(appId: string, olderThan: Date): Promise<readonly UiFile[]> {
        const entries = (await this.readEntries(appId)).filter((entry) => new Date(entry.createdAt) < olderThan);
        return entries.map((entry) => this.toFile(appId, entry));
    }

    async deleteByIds(appId: string, fileIds: readonly string[]): Promise<void> {
        await this.lock.run(`files:${appId}`, async () => {
            const entries = await this.readEntries(appId);
            await writeJsonAtomic(
                this.folders.filesIndex(appId),
                entries.filter((entry) => !fileIds.includes(entry.id))
            );
        });
    }

    private async readEntries(appId: string): Promise<readonly FileEntry[]> {
        if (!isAppId(appId)) return [];
        const parsed = await readJson(this.folders.filesIndex(appId));
        if (parsed === undefined) return [];
        if (!Array.isArray(parsed) || !parsed.every(isFileEntry)) throw new Error(`files.json of ${appId} is damaged`);
        return parsed;
    }

    private toFile(appId: string, entry: FileEntry): UiFile {
        return {
            id: entry.id,
            appId,
            name: entry.name,
            size: entry.size,
            type: entry.type,
            sha256: entry.sha256,
            createdAt: new Date(entry.createdAt)
        };
    }
}
