import { join, resolve } from 'node:path';

const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAppId(value: string): boolean {
    return APP_ID.test(value);
}

/**
 * The layout of the data directory: one folder per app, named by its UUID.
 *
 *     <dataDir>/<appId>/app.json     id, name, revision, createdAt, updatedAt and the document
 *     <dataDir>/<appId>/state.json   the revision and the state snapshot
 *     <dataDir>/<appId>/errors.json  the bounded preview error log
 *     <dataDir>/<appId>/files.json   metadata of the uploaded files
 *     <dataDir>/<appId>/files/<id>   the bytes of one uploaded file
 *
 * Only UUIDs reach a path: an id that is not one is refused here, so no input can name a folder outside `root`
 */
export class AppFolders {
    readonly root: string;

    constructor(dataDir: string) {
        this.root = resolve(dataDir);
    }

    dir(appId: string): string {
        if (!APP_ID.test(appId)) throw new Error('An app id is a UUID');
        return join(this.root, appId.toLowerCase());
    }

    appFile(appId: string): string {
        return join(this.dir(appId), 'app.json');
    }

    stateFile(appId: string): string {
        return join(this.dir(appId), 'state.json');
    }

    errorsFile(appId: string): string {
        return join(this.dir(appId), 'errors.json');
    }

    filesIndex(appId: string): string {
        return join(this.dir(appId), 'files.json');
    }

    fileBytes(appId: string, fileId: string): string {
        if (!FILE_ID.test(fileId)) throw new Error('A file id is a UUID');
        return join(this.dir(appId), 'files', fileId.toLowerCase());
    }
}
