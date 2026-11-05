import type { PartFolders } from './PartFolders.js';
import { isAppId } from './PartFolders.js';
import { readJson } from './atomicFile.js';

/**
 * True when an app with this id is stored: an app of the old store (`<appId>/app.json`) or an app part
 * (`apps/<id>.json`). Files and preview errors are kept in the app's side folder either way
 */
export async function appStored(folders: PartFolders, appId: string): Promise<boolean> {
    if (!isAppId(appId)) return false;
    if ((await readJson(folders.appFile(appId))) !== undefined) return true;
    return (await readJson(folders.partFile('apps', appId))) !== undefined;
}
