import { rm } from 'node:fs/promises';
import { report } from '@punyts/core';
import { diffInstance } from '@punyts/stateui-app/core';
import type { JsonObject as LibraryJsonObject } from '@punyts/stateui-app/core';
import type { InstanceDiff, InstanceRead, PersonDataset, UiInstanceRepository } from '../../application/ports/UiInstanceRepository.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { readJson, writeJsonAtomic } from './atomicFile.js';
import type { KeyedLock } from './KeyedLock.js';
import type { PartFolders } from './PartFolders.js';

/** The keys an instance file may hold, as in the library's `AppInstance` */
const INSTANCE_KEYS: readonly string[] = ['app', 'screens', 'route', 'theme', 'data'];

/** Never the error's message: a JSON parse error quotes the file, which holds what the person typed */
function errorText(error: unknown): string {
    if (error instanceof SyntaxError) return 'the file is not valid JSON';
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    return `the file could not be read (${code})`;
}

/** Why a stored instance is not one, or `undefined` when it is */
function instanceProblem(value: unknown): string | undefined {
    if (!isJsonObject(value)) return 'the file does not hold an object';
    const odd = Object.keys(value).find((key) => !INSTANCE_KEYS.includes(key));
    return odd === undefined ? undefined : `the key "${odd}" is not part of an instance`;
}

function datasetProblem(value: unknown): string | undefined {
    if (!isJsonObject(value)) return 'the file does not hold an object';
    if (typeof value['model'] !== 'string') return 'the file has no model name';
    return isJsonObject(value['records']) ? undefined : 'the file has no records object';
}

/** The category of the instance store's reports: an instance written or reset, a person dataset written */
const STORAGE_CATEGORY = 'stateui-mcp.storage';

/**
 * One person's instances as files (`PartFolders.instanceFile`, `personDataFile`); the owner's own (the person is the
 * owner) unless another person is named. An instance is stored as the diff over its definition, so a definition edit never needs to touch it
 * and an unused app has no file. Every change of one app's instance and datasets runs under the lock key
 * `person/{person}/{appId}`. Reads never throw at the person: an unreadable file reads as nothing, with a `problem`
 */
export class FileUiInstanceRepository implements UiInstanceRepository {
    constructor(
        private readonly folders: PartFolders,
        private readonly lock: KeyedLock,
        private readonly ownerId: string,
        private readonly person: string = ownerId
    ) {}

    async get(appId: string): Promise<InstanceRead<InstanceDiff>> {
        const path = this.folders.instanceFile(this.ownerId, appId, this.person);
        const read = await this.read(path, instanceProblem);
        return read.value === undefined ? { value: {}, ...(read.problem !== undefined && { problem: `The instance of the app ${appId} was ignored: ${read.problem}` }) } : { value: read.value as InstanceDiff };
    }

    async write(appId: string, definition: JsonObject, current: JsonObject): Promise<InstanceDiff> {
        const path = this.folders.instanceFile(this.ownerId, appId, this.person);
        const diff = diffInstance(definition as LibraryJsonObject, current as LibraryJsonObject) as InstanceDiff;
        await this.lock.run(this.key(appId), async () => {
            if (Object.keys(diff).length === 0) await rm(path, { force: true });
            else await writeJsonAtomic(path, diff);
        });
        report(STORAGE_CATEGORY, 'Instance written', { appId, person: this.person, changed: Object.keys(diff).length > 0 });
        return diff;
    }

    async getData(appId: string, binding: string): Promise<InstanceRead<PersonDataset | undefined>> {
        const read = await this.read(this.folders.personDataFile(appId, binding, this.person), datasetProblem);
        if (read.problem !== undefined) return { value: undefined, problem: `The records of "${binding}" in the app ${appId} were ignored: ${read.problem}` };
        return { value: read.value as PersonDataset | undefined };
    }

    async writeData(appId: string, binding: string, dataset: PersonDataset): Promise<void> {
        const path = this.folders.personDataFile(appId, binding, this.person);
        await this.lock.run(this.key(appId), () => writeJsonAtomic(path, { model: dataset.model, records: dataset.records }));
        report(STORAGE_CATEGORY, 'Person data written', { appId, binding, person: this.person, records: Object.keys(dataset.records).length });
    }

    async reset(appId: string): Promise<void> {
        const instance = this.folders.instanceFile(this.ownerId, appId, this.person);
        const data = this.folders.personDataDir(appId, this.person);
        await this.lock.run(this.key(appId), async () => {
            await rm(instance, { force: true });
            await rm(data, { recursive: true, force: true });
        });
        report(STORAGE_CATEGORY, 'Instance reset', { appId, person: this.person });
    }

    private key(appId: string): string {
        return `person/${this.person}/${appId.toLowerCase()}`;
    }

    /** The file's value when it passes `check`; nothing when it is missing; nothing and the reason when it is not readable */
    private async read(path: string, check: (value: unknown) => string | undefined): Promise<{ value?: unknown; problem?: string }> {
        let value: unknown;
        try {
            value = await readJson(path);
        } catch (error) {
            return { problem: errorText(error) };
        }
        if (value === undefined) return {};
        const problem = check(value);
        return problem === undefined ? { value } : { problem };
    }
}
