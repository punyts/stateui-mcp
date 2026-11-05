import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { splitDocument } from '@punyts/stateui-app/core';
import type { AppDocument, JsonObject as LibraryJsonObject, SplitRename, SplitResult } from '@punyts/stateui-app/core';
import { isJsonObject } from '../domain/JsonValue.js';
import { PART_KINDS } from '../domain/partName.js';
import type { PartKind } from '../domain/partName.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { readJson } from '../infrastructure/storage/atomicFile.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { PartFolders, isAppId, isPartId } from '../infrastructure/storage/PartFolders.js';
import { LOCAL_OWNER_ID } from './createServices.js';

/** The folder under the data directory that the converted apps' `app.json` and `state.json` are moved to */
export const CONVERTED_DIR = '.converted';

export interface ConvertDataDirOptions {
    readonly dataDir: string;
    /** Report what would be converted and change nothing */
    readonly dryRun?: boolean;
    /** Delete `.converted/` after converting */
    readonly purge?: boolean;
    /** The owner whose default persona's instances are cleared; default `LOCAL_OWNER_ID` */
    readonly ownerId?: string;
    readonly now?: () => Date;
    readonly newId?: () => string;
}

/** One part the conversion created (or would create) */
export interface ConvertedPart {
    readonly kind: PartKind;
    readonly name: string;
}

export interface ConvertedApp {
    readonly appId: string;
    /** The app's stored name */
    readonly name: string;
    /** Every part, the app last; empty when an earlier run created them and stopped before moving the files */
    readonly parts: readonly ConvertedPart[];
    /** The names the converter changed */
    readonly renamed: readonly SplitRename[];
}

export interface UnconvertedApp {
    readonly appId: string;
    /** Absent when `app.json` does not read */
    readonly name?: string;
    readonly reasons: readonly string[];
}

export interface ConvertReport {
    readonly dataDir: string;
    readonly dryRun: boolean;
    readonly converted: readonly ConvertedApp[];
    readonly unconverted: readonly UnconvertedApp[];
    /** True when `.converted/` was deleted (or would be, in a dry run) */
    readonly purged: boolean;
}

interface OldApp {
    readonly appId: string;
    readonly name: string;
    readonly document: AppDocument;
    readonly snapshot: LibraryJsonObject | undefined;
}

type Plan =
    | { readonly kind: 'convert'; readonly app: OldApp; readonly split: SplitResult }
    /** An apps part already has the app's id: an earlier run created the parts and stopped before moving the files */
    | { readonly kind: 'finish'; readonly app: OldApp }
    | { readonly kind: 'unconverted'; readonly app: UnconvertedApp };

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** The names and ids of the stored parts, read without writing anything (the repository repairs `names.json` as it loads) */
async function storedParts(folders: PartFolders): Promise<{ names: Record<PartKind, Set<string>>; appIds: Set<string> }> {
    const names = Object.fromEntries(PART_KINDS.map((kind) => [kind, new Set<string>()])) as Record<PartKind, Set<string>>;
    const appIds = new Set<string>();
    for (const kind of PART_KINDS) {
        let entries: string[];
        try {
            entries = await readdir(folders.kindDir(kind));
        } catch {
            continue;
        }
        for (const entry of entries) {
            const id = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : '';
            if (!isPartId(id)) continue;
            const file = await readJson(folders.partFile(kind, id)).catch(() => undefined);
            if (!isJsonObject(file) || typeof file['name'] !== 'string') continue;
            names[kind].add(file['name']);
            if (kind === 'apps') appIds.add(id.toLowerCase());
        }
    }
    return { names, appIds };
}

/** The app folders that still hold an `app.json`, by id */
async function oldAppIds(folders: PartFolders): Promise<string[]> {
    let entries: string[];
    try {
        entries = await readdir(folders.root);
    } catch {
        return [];
    }
    const ids: string[] = [];
    for (const entry of entries.filter(isAppId).sort()) {
        if (await exists(folders.appFile(entry))) ids.push(entry.toLowerCase());
    }
    return ids;
}

/** `app.json` and `state.json` of one app, or why they do not read */
async function readOldApp(folders: PartFolders, appId: string): Promise<OldApp | UnconvertedApp> {
    let file: unknown;
    try {
        file = await readJson(folders.appFile(appId));
    } catch (error) {
        return { appId, reasons: [`app.json does not read: ${reasonOf(error)}`] };
    }
    if (!isJsonObject(file) || typeof file['name'] !== 'string' || !isJsonObject(file['document'])) {
        return { appId, reasons: ['app.json has no name or no document'] };
    }
    const name = file['name'];
    let stored: unknown;
    try {
        stored = await readJson(folders.stateFile(appId));
    } catch (error) {
        return { appId, name, reasons: [`state.json does not read: ${reasonOf(error)}`] };
    }
    const state = isJsonObject(stored) ? stored['state'] : undefined;
    return {
        appId,
        name,
        document: file['document'] as unknown as AppDocument,
        snapshot: isJsonObject(state) ? (state as unknown as LibraryJsonObject) : undefined
    };
}

/** The parts of a split in the order they are created, the app last */
function partsOf(split: SplitResult): { kind: PartKind; name: string; body: object }[] {
    const parts: { kind: PartKind; name: string; body: object }[] = [];
    for (const [name, body] of Object.entries(split.themes)) parts.push({ kind: 'themes', name, body });
    for (const [name, body] of Object.entries(split.models)) parts.push({ kind: 'models', name, body });
    for (const [name, body] of Object.entries(split.datasets)) parts.push({ kind: 'data', name, body });
    for (const [name, body] of Object.entries(split.components)) parts.push({ kind: 'components', name, body });
    if (split.app !== undefined) parts.push({ kind: 'apps', name: split.app.name, body: split.app.blueprint });
    return parts;
}

/** Works out every app's conversion from the stored files alone; nothing is written */
async function plan(folders: PartFolders): Promise<Plan[]> {
    const { names, appIds } = await storedParts(folders);
    const plans: Plan[] = [];
    for (const appId of await oldAppIds(folders)) {
        const app = await readOldApp(folders, appId);
        if ('reasons' in app) {
            plans.push({ kind: 'unconverted', app });
            continue;
        }
        if (appIds.has(appId)) {
            plans.push({ kind: 'finish', app });
            continue;
        }
        let split: SplitResult;
        try {
            split = splitDocument({ name: app.name, document: app.document, ...(app.snapshot !== undefined && { snapshot: app.snapshot }), taken: names });
        } catch (error) {
            plans.push({ kind: 'unconverted', app: { appId, name: app.name, reasons: [`the converter failed: ${reasonOf(error)}`] } });
            continue;
        }
        if (split.app === undefined) {
            const reasons = split.report.map((problem) => `${problem.path}: ${problem.reason}`);
            plans.push({ kind: 'unconverted', app: { appId, name: app.name, reasons: reasons.length > 0 ? reasons : ['the converter made no app'] } });
            continue;
        }
        for (const part of partsOf(split)) names[part.kind].add(part.name);
        plans.push({ kind: 'convert', app, split });
    }
    return plans;
}

/**
 * Converts the apps of the old single-document store in a data directory into owner parts, once. For each app folder
 * with an `app.json`: `splitDocument` (the snapshot in `state.json` gives the live data), then the parts are created
 * (the app last, with the app's id as its part id, so its files, errors and instance stay keyed by it), the default
 * persona's instance is cleared (an empty instance has no file: the live data went into the datasets and the converter drops the articulation),
 * and `app.json` and `state.json` move to `.converted/{appId}/`. `errors.json`, `files.json` and the uploaded bytes
 * stay where they are. An app the converter cannot convert keeps its files in place and is reported with the reasons;
 * a second run converts nothing new. An app whose part an earlier run created gets its files moved.
 *
 * The plan is made from the stored files alone, so `dryRun` reports the same and writes nothing. Run it with the
 * server stopped
 */
export async function convertDataDir(options: ConvertDataDirOptions): Promise<ConvertReport> {
    const folders = new PartFolders(options.dataDir);
    const dryRun = options.dryRun === true;
    const plans = await plan(folders);
    const converted: ConvertedApp[] = [];
    const unconverted: UnconvertedApp[] = [];
    const lock = new KeyedLock();
    const parts = new FilePartRepository(folders, lock, { now: options.now ?? (() => new Date()), newId: options.newId ?? randomUUID });
    const instances = new FileUiInstanceRepository(folders, lock, options.ownerId ?? LOCAL_OWNER_ID);

    for (const item of plans) {
        if (item.kind === 'unconverted') {
            unconverted.push(item.app);
            continue;
        }
        const { appId, name } = item.app;
        const created = item.kind === 'convert' ? partsOf(item.split) : [];
        if (!dryRun) {
            for (const part of created) {
                const result = await parts.create({ kind: part.kind, name: part.name, body: part.body as UiPartBodies[PartKind], ...(part.kind === 'apps' && { id: appId }) });
                if (result.kind !== 'created') {
                    throw new Error(`The ${part.kind} part "${part.name}" of the app ${appId} was not created (${result.kind === 'invalid' ? result.reason : result.kind}); stop the server and run the conversion again`);
                }
            }
            if (item.kind === 'convert') await instances.write(appId, {}, {});
            const target = join(folders.root, CONVERTED_DIR, appId);
            await mkdir(target, { recursive: true });
            for (const file of [folders.appFile(appId), folders.stateFile(appId)]) {
                if (await exists(file)) await rename(file, join(target, basename(file)));
            }
        }
        converted.push({ appId, name, parts: created.map((part) => ({ kind: part.kind, name: part.name })), renamed: item.kind === 'convert' ? item.split.renamed : [] });
    }

    const convertedDir = join(folders.root, CONVERTED_DIR);
    const purged = options.purge === true && (await exists(convertedDir));
    if (purged && !dryRun) await rm(convertedDir, { recursive: true, force: true });
    return { dataDir: folders.root, dryRun, converted, unconverted, purged };
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The report as the command prints it */
export function formatConvertReport(report: ConvertReport): string {
    const lines: string[] = [];
    if (report.dryRun) lines.push('Dry run: nothing was changed.');
    if (report.converted.length === 0 && report.unconverted.length === 0) {
        lines.push(`Nothing to convert in ${report.dataDir}.`);
    }
    if (report.converted.length > 0) {
        lines.push(`${report.dryRun ? 'Would convert' : 'Converted'} ${plural(report.converted.length, 'app')}:`);
        for (const app of report.converted) {
            if (app.parts.length === 0) {
                lines.push(`  ${app.name} (${app.appId}): its parts exist from an earlier run; its files ${report.dryRun ? 'would be' : 'were'} moved`);
                continue;
            }
            const list = app.parts.map((part) => `${part.kind} ${part.name}`).join(', ');
            lines.push(`  ${app.name} (${app.appId}): ${plural(app.parts.length, 'part')}: ${list}`);
            for (const renamed of app.renamed) lines.push(`    ${renamed.kind} "${renamed.from}" is named "${renamed.to}"`);
        }
        lines.push(
            `${report.dryRun ? 'Their app.json and state.json would move' : 'Their app.json and state.json moved'} to ${join(report.dataDir, CONVERTED_DIR)}; run again with --purge to delete that folder.`
        );
    }
    if (report.unconverted.length > 0) {
        lines.push(`Not converted, ${plural(report.unconverted.length, 'app')} (the files stay in place):`);
        for (const app of report.unconverted) {
            lines.push(`  ${app.name ?? '(unreadable)'} (${app.appId}):`);
            for (const reason of app.reasons) lines.push(`    ${reason}`);
        }
    }
    if (report.purged) lines.push(`${report.dryRun ? 'Would delete' : 'Deleted'} ${join(report.dataDir, CONVERTED_DIR)}.`);
    return `${lines.join('\n')}\n`;
}
