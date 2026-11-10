import { join, resolve } from 'node:path';
import { isKeyName } from '@punyts/stateui-app/core';
import { DEFAULT_PERSONA, isPersonaName } from '../../domain/InstanceKey.js';
import type { PartKind } from '../../domain/partName.js';
import { isPartKind } from '../../domain/UiPart.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAppId(value: string): boolean {
    return UUID.test(value);
}

/** True for a UUID, the only form of a part id that reaches a path */
export const isPartId = isAppId;

/**
 * The layout of the data directory. The owner's parts are one file per part in a folder per kind, named by the part's
 * UUID, so a rename moves no file; `names.json` maps the names of each kind to ids:
 *
 *     <dataDir>/<kind>/<id>.json     id, kind, name, revision, createdAt, updatedAt and the body (kinds: `PART_KINDS`)
 *     <dataDir>/names.json           { <kind>: { <name>: <id> } }, an index rebuilt from the part files
 *     <dataDir>/rename.pending.json  only while a rename writes several parts: every part file it writes (O2.5)
 *
 * Each app also has a side folder named by its UUID (the app's part id once apps are parts):
 *
 *     <dataDir>/<appId>/app.json     id, name, revision, createdAt, updatedAt and the document (the old store, which only `convert` reads)
 *     <dataDir>/<appId>/state.json   the revision and the state snapshot (the old store, which only `convert` reads)
 *     <dataDir>/<appId>/errors.json  the bounded preview error log
 *     <dataDir>/<appId>/files.json   metadata of the uploaded files
 *     <dataDir>/<appId>/files/<id>   the bytes of one uploaded file
 *
 * The default persona's instances and persona datasets (O2.7), keyed by app id so a rename moves nothing:
 *
 *     <dataDir>/personas/default/apps/<ownerId>/<appId>.json      the instance: the diff over the definition
 *     <dataDir>/personas/default/data/<appId>/<binding>.json      { model, records } of one persona binding (a capital as ^ and its small letter)
 *
 * Only kinds, UUIDs and binding key names reach a path: anything else is refused here, so no input can name a file outside `root`
 */
export class PartFolders {
    readonly root: string;

    constructor(dataDir: string) {
        this.root = resolve(dataDir);
    }

    kindDir(kind: PartKind): string {
        if (!isPartKind(kind)) throw new Error('Not a part kind');
        return join(this.root, kind);
    }

    partFile(kind: PartKind, partId: string): string {
        if (!UUID.test(partId)) throw new Error('A part id is a UUID');
        return join(this.kindDir(kind), `${partId.toLowerCase()}.json`);
    }

    namesFile(): string {
        return join(this.root, 'names.json');
    }

    /** The journal of a rename that writes several part files */
    renameJournal(): string {
        return join(this.root, 'rename.pending.json');
    }

    /** A persona's diff of one app of one owner; the default persona's when none is named */
    instanceFile(ownerId: string, appId: string, persona: string = DEFAULT_PERSONA): string {
        if (!UUID.test(ownerId)) throw new Error('An owner id is a UUID');
        if (!UUID.test(appId)) throw new Error('An app id is a UUID');
        return join(this.personaDir(persona), 'apps', ownerId.toLowerCase(), `${appId.toLowerCase()}.json`);
    }

    /** The folder of a persona's datasets of one app; the default persona's when none is named */
    personaDataDir(appId: string, persona: string = DEFAULT_PERSONA): string {
        if (!UUID.test(appId)) throw new Error('An app id is a UUID');
        return join(this.personaDir(persona), 'data', appId.toLowerCase());
    }

    private personaDir(persona: string): string {
        if (!isPersonaName(persona)) throw new Error('A persona name is lower-case letters, digits and dashes');
        return join(this.root, 'personas', persona);
    }

    /**
     * The records of one persona binding. A binding name is a key name (`[A-Za-z_][A-Za-z0-9_]*`); each capital becomes
     * `^` and its small letter (`notesByDay` is `notes^by^day.json`), so two names that differ in case get two files on a
     * file system that ignores case
     */
    personaDataFile(appId: string, binding: string, persona: string = DEFAULT_PERSONA): string {
        if (!isKeyName(binding)) throw new Error('A binding name is a key name');
        const file = binding.replace(/[A-Z]/g, (capital) => `^${capital.toLowerCase()}`);
        return join(this.personaDataDir(appId, persona), `${file}.json`);
    }

    dir(appId: string): string {
        if (!UUID.test(appId)) throw new Error('An app id is a UUID');
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
        if (!UUID.test(fileId)) throw new Error('A file id is a UUID');
        return join(this.dir(appId), 'files', fileId.toLowerCase());
    }
}
