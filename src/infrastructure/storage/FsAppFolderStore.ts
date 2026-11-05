import { rm } from 'node:fs/promises';
import type { AppFolderStore } from '../../application/ports/AppFolderStore.js';
import type { PartFolders } from './PartFolders.js';
import { isAppId } from './PartFolders.js';
import type { KeyedLock } from './KeyedLock.js';

/** The side folders of app parts on disk (`<dataDir>/<appId>/`: `errors.json`, `files.json` and `files/`) */
export class FsAppFolderStore implements AppFolderStore {
    constructor(
        private readonly folders: PartFolders,
        private readonly lock: KeyedLock
    ) {}

    async remove(appId: string): Promise<void> {
        if (!isAppId(appId)) return;
        // The error log and the file index each write under their own lock; wait for both before the folder goes
        await this.lock.run(`errors:${appId}`, () => this.lock.run(`files:${appId}`, () => rm(this.folders.dir(appId), { recursive: true, force: true })));
    }
}
