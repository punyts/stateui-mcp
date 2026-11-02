import { randomUUID } from 'node:crypto';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
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
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { INITIAL_REVISION, isRevisionCurrent, nextRevision } from '../../domain/revision.js';
import type { UiApp, UiDocument, UiStateSnapshot, UiSyncMode } from '../../domain/UiApp.js';
import type { AppAuthorities } from '../sync/AppAuthorities.js';
import type { PersistedStates } from '../sync/PersistedStates.js';
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
    /** Absent: `full` */
    readonly sync?: UiSyncMode;
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
        isJsonObject(value['document']) &&
        (value['sync'] === undefined || value['sync'] === 'full' || value['sync'] === 'persisted')
    );
}

/**
 * Apps as folders of JSON files (see `AppFolders`). Every write is a temporary file renamed into place, and the
 * writes of one app run one at a time, so a compare-and-set on the revision is real. Documents are written with
 * `JSON.stringify` and read with `JSON.parse` and nothing in between rebuilds an object, so the order of `children`
 * and of keyed data maps survives (integer-like keys are refused before they get here).
 *
 * The state is not in `app.json`: it is the app's sync authority (`AppAuthorities`), which keeps it in `state.json`
 * (or relays it to the statenet), or, for a Persisted app, the statenet (`PersistedStates`)
 */
export class FileUiAppRepository implements UiAppRepository {
    constructor(
        private readonly folders: AppFolders,
        private readonly lock: KeyedLock,
        private readonly states: AppAuthorities,
        private readonly now: () => Date = () => new Date(),
        private readonly newId: () => string = randomUUID,
        /** Absent: no statenet, so no Persisted apps */
        private readonly persisted?: PersistedStates
    ) {}

    async create(input: CreateUiAppInput): Promise<CreateUiAppResult> {
        return this.lock.run(CREATE_LOCK, async (): Promise<CreateUiAppResult> => {
            const existing = await this.list();
            if (existing.some((app) => app.name === input.name)) return { kind: 'duplicate-name' };
            if (input.sync === 'persisted' && this.persisted === undefined) return { kind: 'no-statenet' };
            const id = this.newId();
            const stamp = this.now();
            const file: AppFile = {
                id,
                name: input.name,
                revision: INITIAL_REVISION,
                createdAt: stamp.toISOString(),
                updatedAt: stamp.toISOString(),
                document: input.document,
                ...(input.sync === 'persisted' && { sync: input.sync })
            };
            await writeJsonAtomic(this.folders.appFile(id), file);
            return { kind: 'created', app: this.toApp(file, await this.stateOf(file)) };
        });
    }

    async findById(appId: string): Promise<UiApp | undefined> {
        if (!isAppId(appId)) return undefined;
        const file = await this.readApp(appId);
        if (file === undefined) return undefined;
        return this.toApp(file, await this.stateOf(file));
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
            apps.push({ id: file.id, name: file.name, revision: file.revision, updatedAt: new Date(file.updatedAt) });
        }
        return apps.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.name.localeCompare(b.name));
    }

    async writeDocument(appId: string, document: UiDocument, expectedRevision: number): Promise<UiAppWriteResult> {
        return this.withApp(appId, expectedRevision, async (file) => {
            const revision = nextRevision(file.revision);
            await writeJsonAtomic(this.folders.appFile(appId), { ...file, revision, updatedAt: this.now().toISOString(), document });
            return { kind: 'written', revision };
        });
    }

    async writeState(appId: string, statePath: readonly string[], value: JsonValue, expectedRevision: number): Promise<UiAppWriteResult> {
        return this.withApp(appId, expectedRevision, async (file) => {
            if (file.sync === 'persisted') throw new Error(`App ${appId} is Persisted: the server does not change its state`);
            const authority = await this.states.authority(appId, file.document);
            authority.write({ path: `$.${statePath.join('.')}`, op: 'set', value: value as SyncValue });
            return { kind: 'written', revision: file.revision };
        });
    }

    async delete(appId: string, expectedRevision: number): Promise<UiAppDeleteResult> {
        if (!isAppId(appId)) return { kind: 'not-found' };
        return this.lock.run(appId, async (): Promise<UiAppDeleteResult> => {
            const file = await this.readApp(appId);
            if (file === undefined) return { kind: 'not-found' };
            if (file.revision !== expectedRevision) return { kind: 'conflict', currentRevision: file.revision };
            await (file.sync === 'persisted' ? this.persisted?.forget(appId) : this.states.forget(appId));
            await rm(this.folders.dir(appId), { recursive: true, force: true });
            return { kind: 'deleted' };
        });
    }

    /** Runs `write` under the lock of the app when the app exists and its revision is the expected one */
    private async withApp(
        appId: string,
        expectedRevision: number,
        write: (file: AppFile) => Promise<UiAppWriteResult>
    ): Promise<UiAppWriteResult> {
        if (!isAppId(appId)) return { kind: 'not-found' };
        return this.lock.run(appId, async (): Promise<UiAppWriteResult> => {
            const file = await this.readApp(appId);
            if (file === undefined) return { kind: 'not-found' };
            if (!isRevisionCurrent(file.revision, expectedRevision)) return { kind: 'conflict', currentRevision: file.revision };
            return write(file);
        });
    }

    private async readApp(appId: string): Promise<AppFile | undefined> {
        const parsed = await readJson(this.folders.appFile(appId));
        if (parsed === undefined) return undefined;
        if (!isAppFile(parsed)) throw new Error(`app.json of ${appId} is damaged`);
        return parsed;
    }

    private stateOf(file: AppFile): Promise<UiStateSnapshot> {
        if (file.sync !== 'persisted') return this.states.state(file.id, file.document);
        if (this.persisted === undefined) throw new Error(`App ${file.id} is Persisted: start the server with --statenet`);
        return this.persisted.state(file.id, file.document);
    }

    private toApp(file: AppFile, state: UiStateSnapshot): UiApp {
        return {
            id: file.id,
            name: file.name,
            revision: file.revision,
            document: file.document,
            stateSnapshot: state,
            sync: file.sync ?? 'full',
            createdAt: new Date(file.createdAt),
            updatedAt: new Date(file.updatedAt)
        };
    }
}
