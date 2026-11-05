import { access } from 'node:fs/promises';
import type { NamespaceStorage, StoredNamespace } from '@punyts/state-sync/authority';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { PartFolders } from '../storage/PartFolders.js';
import { isAppId } from '../storage/PartFolders.js';
import { readJson, writeJsonAtomic } from '../storage/atomicFile.js';

const NAMESPACE_PREFIX = 'apps.';

/** The sync namespace of an app: `apps.<appId>` */
export function appNamespace(appId: string): string {
    return `${NAMESPACE_PREFIX}${appId.toLowerCase()}`;
}

function appIdOf(namespace: string): string {
    const appId = namespace.slice(NAMESPACE_PREFIX.length);
    if (!namespace.startsWith(NAMESPACE_PREFIX) || !isAppId(appId)) throw new Error(`${namespace} is not the namespace of an app`);
    return appId;
}

function isStoredNamespace(value: unknown): value is StoredNamespace {
    return (
        isJsonObject(value) &&
        isJsonObject(value['state']) &&
        typeof value['revision'] === 'number' &&
        Array.isArray(value['log']) &&
        Array.isArray(value['applied'])
    );
}

/**
 * The state of each app's authority as `state.json` in the app's folder: the state, its revision, the change log and
 * the applied change ids. A save after the app was deleted is dropped, so a delete that races a save leaves no folder
 */
export class FileNamespaceStorage implements NamespaceStorage {
    constructor(private readonly folders: PartFolders) {}

    async load(namespace: string): Promise<StoredNamespace | undefined> {
        const parsed = await readJson(this.folders.stateFile(appIdOf(namespace)));
        if (parsed === undefined) return undefined;
        if (!isStoredNamespace(parsed)) throw new Error(`state.json of ${namespace} is damaged`);
        return parsed;
    }

    async save(namespace: string, stored: StoredNamespace): Promise<void> {
        const appId = appIdOf(namespace);
        try {
            await access(this.folders.appFile(appId));
        } catch {
            return;
        }
        await writeJsonAtomic(this.folders.stateFile(appId), stored);
    }
}
