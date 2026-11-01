import { isJsonObject } from '../../domain/JsonValue.js';
import { MAX_PREVIEW_ERRORS } from '../../domain/limits.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { AppFolders } from './AppFolders.js';
import { isAppId } from './AppFolders.js';
import { readJson, writeJsonAtomic } from './atomicFile.js';
import type { KeyedLock } from './KeyedLock.js';

function isErrorList(value: unknown): value is UiBuildError[] {
    return Array.isArray(value) && value.every((item) => isJsonObject(item) && typeof item['code'] === 'string' && typeof item['message'] === 'string');
}

/** The bounded runtime error log of an app in `errors.json`: the newest `MAX_PREVIEW_ERRORS` are kept, oldest first */
export class FileUiErrorLog {
    constructor(
        private readonly folders: AppFolders,
        private readonly lock: KeyedLock
    ) {}

    /** False when the app has no folder, so nothing is created for an app that does not exist */
    async append(appId: string, error: UiBuildError): Promise<boolean> {
        if (!isAppId(appId) || (await readJson(this.folders.appFile(appId))) === undefined) return false;
        return this.lock.run(`errors:${appId}`, async () => {
            const kept = await this.list(appId);
            await writeJsonAtomic(this.folders.errorsFile(appId), [...kept, error].slice(-MAX_PREVIEW_ERRORS));
            return true;
        });
    }

    async list(appId: string): Promise<readonly UiBuildError[]> {
        if (!isAppId(appId)) return [];
        const parsed = await readJson(this.folders.errorsFile(appId));
        if (parsed === undefined) return [];
        if (!isErrorList(parsed)) throw new Error(`errors.json of ${appId} is damaged`);
        return parsed;
    }

    async clear(appId: string): Promise<void> {
        if (!isAppId(appId) || (await readJson(this.folders.appFile(appId))) === undefined) return;
        await this.lock.run(`errors:${appId}`, () => writeJsonAtomic(this.folders.errorsFile(appId), []));
    }
}
