import { cp, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import type { UiFileRepository } from '../application/ports/UiFileRepository.js';
import type { UiFileStore } from '../application/ports/UiFileStore.js';
import type { UiPartRepository } from '../application/ports/UiPartRepository.js';
import { MAX_FILE_BYTES } from '../domain/UiFile.js';
import type { UiPart } from '../domain/UiPart.js';
import { PART_KINDS } from '../domain/partName.js';
import { packageRoot } from '../infrastructure/http/packageRoot.js';
import { writeJsonAtomic } from '../infrastructure/storage/atomicFile.js';
import { isAppId, PartFolders } from '../infrastructure/storage/PartFolders.js';

/** The name of the app the showcase installs */
export const SHOWCASE_APP = 'component-showcase';

/** The built showcase parts this package ships, in the layout of a data directory (`npm run showcase:build` writes them) */
export function showcasePartsDir(): string {
    return join(packageRoot(), 'showcase', 'parts');
}

function isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function entries(dir: string): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

/**
 * True when the data directory holds any part: a part file of any kind, or an app of the old single-document store
 * (`<appId>/app.json`) that `convert` would turn into parts. A missing directory holds none
 */
export async function holdsParts(dataDir: string): Promise<boolean> {
    const folders = new PartFolders(dataDir);
    for (const kind of PART_KINDS) {
        if ((await entries(folders.kindDir(kind))).some((entry) => entry.endsWith('.json'))) return true;
    }
    for (const entry of await entries(folders.root)) {
        if (isAppId(entry) && (await exists(folders.appFile(entry)))) return true;
    }
    return false;
}

/** Writes `names.json` from the part files of the data directory, every kind and the names in order, as the part repository keeps it */
async function writeNames(folders: PartFolders): Promise<void> {
    const names: Record<string, Record<string, string>> = {};
    for (const kind of PART_KINDS) {
        const index: [string, string][] = [];
        for (const entry of (await entries(folders.kindDir(kind))).sort()) {
            if (!entry.endsWith('.json')) continue;
            const part = JSON.parse(await readFile(join(folders.kindDir(kind), entry), 'utf8')) as { id: string; name: string };
            index.push([part.name, part.id]);
        }
        names[kind] = Object.fromEntries(index.sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    await writeJsonAtomic(folders.namesFile(), names);
}

export interface InstallShowcaseOptions {
    readonly dataDir: string;
    readonly report: UseCaseReport;
    /** The built parts to copy; default the ones this package ships */
    readonly sourceDir?: string;
}

/**
 * Installs the component showcase on a data directory that holds no parts at all (a new or empty one): copies the
 * built parts and the app's files, then writes `names.json`. It never overwrites or adds to a directory that holds a
 * part, so deleting the showcase keeps it deleted while anything else is there. True when it installed
 */
export async function installShowcase(options: InstallShowcaseOptions): Promise<boolean> {
    if (await holdsParts(options.dataDir)) return false;
    const source = options.sourceDir ?? showcasePartsDir();
    if (!(await exists(source))) {
        options.report.info('Component showcase not installed: its parts are missing from the package', { source });
        return false;
    }
    const folders = new PartFolders(options.dataDir);
    await cp(source, folders.root, { recursive: true, force: false, errorOnExist: false });
    await writeNames(folders);
    options.report.info('Installed the component showcase on the new data directory', { app: SHOWCASE_APP, dataDir: folders.root });
    return true;
}

export interface InstallShowcaseIntoOptions {
    /** The empty workspace's storage: the showcase goes in only when it holds no part */
    readonly parts: UiPartRepository;
    readonly files: UiFileRepository;
    readonly fileStore: UiFileStore;
    /**
     * Stores a part exactly as given, id, name, revision and dates included, without the checks of `create`: the
     * showcase holds parts made before today's name rules. Without it the parts go through `create`
     */
    readonly importPart?: (part: UiPart) => Promise<void>;
    readonly report: UseCaseReport;
    /** The built parts to install; default the package's showcase */
    readonly sourceDir?: string;
}

/**
 * Installs the component showcase into a workspace kept in storage other than files (a database), as `installShowcase`
 * does for a data directory: every part with its id, and the uploaded files of its apps with their bytes. Only a
 * workspace with no part at all gets it. True when it installed
 */
export async function installShowcaseInto(options: InstallShowcaseIntoOptions): Promise<boolean> {
    for (const kind of PART_KINDS) if ((await options.parts.list(kind)).length > 0) return false;
    const source = options.sourceDir ?? showcasePartsDir();
    if (!(await exists(source))) {
        options.report.info('Component showcase not installed: its parts are missing from the package', { source });
        return false;
    }
    const folders = new PartFolders(source);
    for (const kind of PART_KINDS) {
        for (const entry of (await entries(folders.kindDir(kind))).sort()) {
            if (!entry.endsWith('.json')) continue;
            const part = JSON.parse(await readFile(join(folders.kindDir(kind), entry), 'utf8')) as { id: string; name: string; revision: number; createdAt: string; updatedAt: string; body: object };
            if (options.importPart !== undefined) {
                await options.importPart({ id: part.id, kind, name: part.name, revision: part.revision, body: part.body as never, createdAt: new Date(part.createdAt), updatedAt: new Date(part.updatedAt) });
                continue;
            }
            const created = await options.parts.create({ kind, name: part.name, body: part.body as never, id: part.id });
            if (created.kind !== 'created') throw new Error(`The showcase part ${kind}/${part.name} could not be installed: ${created.kind === 'invalid' ? created.reason : created.kind}`);
        }
    }
    for (const appId of (await entries(folders.root)).filter(isAppId)) {
        const index = JSON.parse(await readFile(join(folders.dir(appId), 'files.json'), 'utf8').catch(() => '[]')) as Array<{ id: string; name: string; type: string }>;
        for (const file of index) {
            const bytes = await readFile(folders.fileBytes(appId, file.id));
            const saved = await options.fileStore.save(appId, file.id, (async function* () {
                yield new Uint8Array(bytes);
            })(), MAX_FILE_BYTES);
            if (saved.kind !== 'saved') throw new Error(`The showcase file ${file.name} is too large`);
            await options.files.add({ id: file.id, appId, name: file.name, size: saved.size, type: file.type, sha256: saved.sha256 });
        }
    }
    options.report.info('Installed the component showcase in the new workspace', { app: SHOWCASE_APP });
    return true;
}
