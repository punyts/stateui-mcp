import type { PartFolders } from './PartFolders.js';
import { isAppId } from './PartFolders.js';
import { readJson } from './atomicFile.js';

/**
 * True when an app part with this id is stored (`apps/<id>.json`). Files and preview errors are kept in the app's side
 * folder
 */
export async function appStored(folders: PartFolders, appId: string): Promise<boolean> {
    if (!isAppId(appId)) return false;
    return (await readJson(folders.partFile('apps', appId))) !== undefined;
}
