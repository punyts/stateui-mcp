import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import type {
    CreateUiAppInput,
    CreateUiAppResult,
    UiAppDeleteResult,
    UiAppRepository,
    UiAppSummary,
    UiAppWriteResult
} from '../../application/ports/UiAppRepository.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { INITIAL_REVISION, isRevisionCurrent, nextRevision } from '../../domain/revision.js';
import type { UiApp, UiDocument, UiStateSnapshot } from '../../domain/UiApp.js';
import type { AppFolders } from './AppFolders.js';
import { isAppId } from './AppFolders.js';
import { isMissing, readJson, writeJsonAtomic } from './atomicFile.js';
import type { KeyedLock } from './KeyedLock.js';

/** `app.json`: everything about an app except its state */
interface AppFile {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly document: JsonObject;
}

/** `state.json`: the snapshot and the revision it belongs to */
interface StateFile {
    readonly revision: number;
    readonly snapshot: JsonObject;
}

const CREATE_LOCK = 'create';

function isAppFile(value: unknown): value is AppFile {
    return (
        isJsonObject(value) &&
        typeof value['id'] === 'string' &&
        typeof value['name'] === 'string' &&
        typeof value['revision'] === 'number' &&
        typeof value['createdAt'] === 'string' &&
        typeof value['updatedAt'] === 'string' &&
        isJsonObject(value['document'])
    );
}

function isStateFile(value: unknown): value is StateFile {
    return isJsonObject(value) && typeof value['revision'] === 'number' && isJsonObject(value['snapshot']);
}

/**
 * Apps as folders of JSON files (see `AppFolders`). Every write is a temporary file renamed into place, and the
 * writes of one app run one at a time, so a compare-and-set on the revision is real. Documents and snapshots are
 * written with `JSON.stringify` and read with `JSON.parse` and nothing in between rebuilds an object, so the order
 * of `children` and of keyed data maps survives (integer-like keys are refused before they get here).
 *
 * The state write that raises the revision writes `state.json` first and `app.json` second; a read takes the higher
 * of the two revisions, so a crash between them leaves a consistent app at the new revision
 */
export class FileUiAppRepository implements UiAppRepository {
    constructor(
        private readonly folders: AppFolders,
        private readonly lock: KeyedLock,
        private readonly now: () => Date = () => new Date(),
        private readonly newId: () => string = randomUUID
    ) {}

    async create(input: CreateUiAppInput): Promise<CreateUiAppResult> {
        return this.lock.run(CREATE_LOCK, async (): Promise<CreateUiAppResult> => {
            const existing = await this.list();
            if (existing.some((app) => app.name === input.name)) return { kind: 'duplicate-name' };
            const id = this.newId();
            const stamp = this.now();
            const file: AppFile = {
                id,
                name: input.name,
                revision: INITIAL_REVISION,
                createdAt: stamp.toISOString(),
                updatedAt: stamp.toISOString(),
                document: input.document
            };
            const state: StateFile = { revision: INITIAL_REVISION, snapshot: {} };
            await writeJsonAtomic(this.folders.stateFile(id), state);
            await writeJsonAtomic(this.folders.appFile(id), file);
            return { kind: 'created', app: this.toApp(file, state) };
        });
    }

    async findById(appId: string): Promise<UiApp | undefined> {
        if (!isAppId(appId)) return undefined;
        const file = await this.readApp(appId);
        if (file === undefined) return undefined;
        return this.toApp(file, await this.readState(appId));
    }

    async list(): Promise<readonly UiAppSummary[]> {
        let names: string[];
        try {
            names = await readdir(this.folders.root);
        } catch (error) {
            if (isMissing(error)) return [];
            throw error;
        }
        const apps: UiAppSummary[] = [];
        for (const name of names.filter(isAppId)) {
            const file = await this.readApp(name);
            if (file === undefined) continue;
            const state = await this.readState(name);
            apps.push({ id: file.id, name: file.name, revision: Math.max(file.revision, state.revision), updatedAt: new Date(file.updatedAt) });
        }
        return apps.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.name.localeCompare(b.name));
    }

    async writeDocument(appId: string, document: UiDocument, expectedRevision: number): Promise<UiAppWriteResult> {
        return this.withApp(appId, expectedRevision, async (file, state) => {
            const revision = nextRevision(Math.max(file.revision, state.revision));
            await writeJsonAtomic(this.folders.appFile(appId), { ...file, revision, updatedAt: this.now().toISOString(), document });
            return { kind: 'written', revision };
        });
    }

    async writeStateSnapshot(appId: string, snapshot: UiStateSnapshot, expectedRevision: number): Promise<UiAppWriteResult> {
        return this.withApp(appId, expectedRevision, async (file, state) => {
            const revision = nextRevision(Math.max(file.revision, state.revision));
            const next: StateFile = { revision, snapshot };
            await writeJsonAtomic(this.folders.stateFile(appId), next);
            await writeJsonAtomic(this.folders.appFile(appId), { ...file, revision, updatedAt: this.now().toISOString() });
            return { kind: 'written', revision };
        });
    }

    async savePreviewSnapshot(appId: string, snapshot: UiStateSnapshot, expectedRevision: number): Promise<UiAppWriteResult> {
        return this.withApp(appId, expectedRevision, async (file, state) => {
            const revision = Math.max(file.revision, state.revision);
            const next: StateFile = { revision, snapshot };
            await writeJsonAtomic(this.folders.stateFile(appId), next);
            return { kind: 'written', revision };
        });
    }

    async delete(appId: string, expectedRevision: number): Promise<UiAppDeleteResult> {
        if (!isAppId(appId)) return { kind: 'not-found' };
        return this.lock.run(appId, async (): Promise<UiAppDeleteResult> => {
            const file = await this.readApp(appId);
            if (file === undefined) return { kind: 'not-found' };
            const state = await this.readState(appId);
            const current = Math.max(file.revision, state.revision);
            if (current !== expectedRevision) return { kind: 'conflict', currentRevision: current };
            await rm(this.folders.dir(appId), { recursive: true, force: true });
            return { kind: 'deleted' };
        });
    }

    /** Runs `write` under the lock of the app when the app exists and its revision is the expected one */
    private async withApp(
        appId: string,
        expectedRevision: number,
        write: (file: AppFile, state: StateFile) => Promise<UiAppWriteResult>
    ): Promise<UiAppWriteResult> {
        if (!isAppId(appId)) return { kind: 'not-found' };
        return this.lock.run(appId, async (): Promise<UiAppWriteResult> => {
            const file = await this.readApp(appId);
            if (file === undefined) return { kind: 'not-found' };
            const state = await this.readState(appId);
            const current = Math.max(file.revision, state.revision);
            if (!isRevisionCurrent(current, expectedRevision)) return { kind: 'conflict', currentRevision: current };
            return write(file, state);
        });
    }

    private async readApp(appId: string): Promise<AppFile | undefined> {
        const parsed = await readJson(this.folders.appFile(appId));
        if (parsed === undefined) return undefined;
        if (!isAppFile(parsed)) throw new Error(`app.json of ${appId} is damaged`);
        return parsed;
    }

    private async readState(appId: string): Promise<StateFile> {
        const parsed = await readJson(this.folders.stateFile(appId));
        if (parsed === undefined) return { revision: INITIAL_REVISION, snapshot: {} };
        if (!isStateFile(parsed)) throw new Error(`state.json of ${appId} is damaged`);
        return parsed;
    }

    private toApp(file: AppFile, state: StateFile): UiApp {
        return {
            id: file.id,
            name: file.name,
            revision: Math.max(file.revision, state.revision),
            document: file.document,
            stateSnapshot: state.snapshot,
            createdAt: new Date(file.createdAt),
            updatedAt: new Date(file.updatedAt)
        };
    }
}
