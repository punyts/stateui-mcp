import type { UiViewLoad } from '../../application/ports/UiPreviewLog.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { MAX_PREVIEW_ERRORS } from '../../domain/limits.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { PartFolders } from './PartFolders.js';
import { isAppId } from './PartFolders.js';
import { readJson, writeJsonAtomic } from './atomicFile.js';
import type { KeyedLock } from './KeyedLock.js';

/** One stored error with the view load it came from, when it is known */
interface LoggedError {
    readonly error: UiBuildError;
    readonly source?: UiViewLoad;
}

function isError(value: unknown): value is UiBuildError {
    return isJsonObject(value) && typeof value['code'] === 'string' && typeof value['message'] === 'string';
}

function isSource(value: unknown): value is UiViewLoad {
    return isJsonObject(value) && typeof value['viewId'] === 'string' && typeof value['load'] === 'number';
}

/** Reads an entry; a bare error is the format before sources were kept */
function toEntry(value: unknown): LoggedError | undefined {
    if (isError(value)) return { error: value };
    if (!isJsonObject(value) || !isError(value['error'])) return undefined;
    return isSource(value['source']) ? { error: value['error'], source: value['source'] } : { error: value['error'] };
}

/**
 * The bounded runtime error log of an app in `errors.json`: the newest `MAX_PREVIEW_ERRORS` are kept, oldest first.
 * Each error keeps the view load it came from, so a later load of a view can drop the errors that no longer happen
 */
export class FileUiErrorLog {
    constructor(
        private readonly folders: PartFolders,
        private readonly lock: KeyedLock
    ) {}

    /** False when the app has no folder, so nothing is created for an app that does not exist */
    async append(appId: string, error: UiBuildError, source?: UiViewLoad): Promise<boolean> {
        if (!(await this.exists(appId))) return false;
        return this.lock.run(`errors:${appId}`, async () => {
            const kept = await this.entries(appId);
            const entry: LoggedError = source === undefined ? { error } : { error, source: { viewId: source.viewId, load: source.load } };
            await writeJsonAtomic(this.folders.errorsFile(appId), [...kept, entry].slice(-MAX_PREVIEW_ERRORS));
            return true;
        });
    }

    /** Keeps only the errors of `source.viewId` from `source.load` on: what earlier loads and other views left is dropped */
    async keepFrom(appId: string, source: UiViewLoad): Promise<boolean> {
        if (!(await this.exists(appId))) return false;
        return this.lock.run(`errors:${appId}`, async () => {
            const entries = await this.entries(appId);
            const kept = entries.filter((entry) => entry.source?.viewId === source.viewId && entry.source.load >= source.load);
            if (kept.length !== entries.length) await writeJsonAtomic(this.folders.errorsFile(appId), kept);
            return true;
        });
    }

    async list(appId: string): Promise<readonly UiBuildError[]> {
        return (await this.entries(appId)).map((entry) => entry.error);
    }

    async clear(appId: string): Promise<void> {
        if (!(await this.exists(appId))) return;
        await this.lock.run(`errors:${appId}`, () => writeJsonAtomic(this.folders.errorsFile(appId), []));
    }

    private async exists(appId: string): Promise<boolean> {
        return isAppId(appId) && (await readJson(this.folders.appFile(appId))) !== undefined;
    }

    private async entries(appId: string): Promise<readonly LoggedError[]> {
        if (!isAppId(appId)) return [];
        const parsed = await readJson(this.folders.errorsFile(appId));
        if (parsed === undefined) return [];
        const entries = Array.isArray(parsed) ? parsed.map(toEntry) : [undefined];
        if (entries.some((entry) => entry === undefined)) throw new Error(`errors.json of ${appId} is damaged`);
        return entries as LoggedError[];
    }
}
