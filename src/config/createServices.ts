import { randomUUID } from 'node:crypto';
import { CORE_ICON_NAMES } from '@punyts/stateui-components';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import type { CategoryIndexEntry } from '../application/ports/ComponentCatalog.js';
import type { ThemePresetSummary } from '../application/ports/PatternCatalog.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { WriteData } from '../application/use-cases/WriteData.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';
import { createUiBuilderUseCases } from './createUiBuilder.js';
import type { UiBuilderUseCases } from './createUiBuilder.js';
import { BrowserPreview } from '../infrastructure/preview/BrowserPreview.js';
import type { PreviewBrowser } from '../infrastructure/preview/BrowserPreview.js';
import { InstanceViews } from '../infrastructure/preview/InstanceViews.js';
import { LivePreviewLog } from '../infrastructure/preview/LivePreviewLog.js';
import { LiveViews } from '../infrastructure/preview/LiveViews.js';
import { PreviewHub } from '../infrastructure/preview/PreviewHub.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';
import { FileUiErrorLog } from '../infrastructure/storage/FileUiErrorLog.js';
import { FileUiFileRepository } from '../infrastructure/storage/FileUiFileRepository.js';
import { FsAppFolderStore } from '../infrastructure/storage/FsAppFolderStore.js';
import { FsUiFileStore } from '../infrastructure/storage/FsUiFileStore.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { AppAuthorities } from '../infrastructure/sync/AppAuthorities.js';
import { AuthorityInstanceStates } from '../infrastructure/sync/AuthorityInstanceStates.js';
import { DatasetHub } from '../infrastructure/sync/DatasetHub.js';
import type { AppCalls, AppProcedure } from '../infrastructure/sync/AppCalls.js';
import type { ToolCallLog } from '../application/ports/ToolCallLog.js';

export interface ServicesOptions {
    /** Where the parts, instances and app files live */
    readonly dataDir: string;
    readonly report: UseCaseReport;
    /** The origin the HTTP server listens on. A function, because the port may be chosen when the server starts */
    readonly origin: () => string;
    /** Replaces the Playwright browser, for tests */
    readonly browser?: PreviewBrowser;
    /** Extra arguments for the headless Chromium, for tests (none by default; ignored with `browser`) */
    readonly browserArgs?: readonly string[];
    /** The key that encrypts `$.server` at rest */
    readonly serverKey?: Uint8Array;
    /** The server procedures Full-mode logic `call`s by name; other names wait for the agent */
    readonly procedures?: Readonly<Record<string, AppProcedure>>;
    /** A file that gets one JSON line per tool call; absent: no log */
    readonly toolLog?: string;
    /** The id of the local owner, whose default persona's instances are stored under it; default `LOCAL_OWNER_ID` */
    readonly ownerId?: string;
}

/** The one owner of a local server: the owner of the parts and, as the default persona, their one user */
export const LOCAL_OWNER_ID = '00000000-0000-4000-8000-000000000001';

/** Everything the transports need: the use cases, the live views and the browser */
export interface Services {
    readonly useCases: UiBuilderUseCases;
    readonly hub: PreviewHub;
    /** The sync authority of each running instance: the views connect to it, the tools write through it */
    readonly authorities: AppAuthorities;
    /** The calls of Full-mode logic that wait for the agent's answer */
    readonly calls: AppCalls;
    readonly liveViews: LiveViews;
    /** The views of the owner's apps (parts): the assembled app and its instance's authority */
    readonly instanceViews: InstanceViews;
    /** The catalog's category index, for the server instructions */
    readonly categoryIndex: readonly CategoryIndexEntry[];
    /** The library's theme preset names, for the server instructions */
    readonly presets: readonly ThemePresetSummary[];
    /** Finishes a part rename that a crash stopped halfway (`rename.pending.json`); true when there was one */
    readonly recoverParts: () => Promise<boolean>;
    readonly browser: PreviewBrowser;
    readonly report: UseCaseReport;
    readonly viewUrl: (appId: string) => string;
    /** Records every tool call, when `toolLog` is set */
    readonly toolCallLog?: ToolCallLog;
}

/** The composition root of the server: plain factories, no container */
export function createServices(options: ServicesOptions): Services {
    const folders = new PartFolders(options.dataDir);
    const lock = new KeyedLock();
    const now = (): Date => new Date();
    const hub = new PreviewHub(now);
    const { validator, catalog, patterns, library, toolCallLog } = createStateUiAdapters({ report: options.report, ...(options.toolLog !== undefined && { toolLog: options.toolLog }) });
    const partFiles = new FilePartRepository(folders, lock, { now, newId: randomUUID });
    const parts = new IndexedUiPartRepository(partFiles);
    // Instances bound to one shared dataset see each other's changes (Full mode)
    const writeData = new WriteData(parts, validator, randomUUID, options.report);
    const datasets = new DatasetHub(parts, (name, operations) => writeData.execute({ name, operations }), options.report);
    const authorities = new AppAuthorities(
        (appId, name, value, viewId) => {
            hub.recordEvent(appId, viewId, name, value);
            hub.touch(appId, viewId);
        },
        options.serverKey,
        { library, report: options.report, ...(options.procedures !== undefined && { procedures: options.procedures }) },
        datasets
    );
    const ownerId = options.ownerId ?? LOCAL_OWNER_ID;
    const instances = new FileUiInstanceRepository(folders, lock, ownerId);
    const instanceStates = new AuthorityInstanceStates(parts, instances, authorities, ownerId, (message, fields) => options.report.info(message, fields), datasets);
    const fileRepository = new FileUiFileRepository(folders, lock, now);
    const fileStore = new FsUiFileStore(folders);
    const previewLog = new LivePreviewLog(hub, new FileUiErrorLog(folders, lock), fileRepository);
    const useCases = createUiBuilderUseCases(
        { parts, instances, instanceStates, validator, previewLog, catalog, patterns, fileRepository, fileStore, appFolders: new FsAppFolderStore(folders, lock) },
        { now, newId: randomUUID, report: options.report }
    );
    const browser = options.browser ?? new BrowserPreview(hub, options.origin, options.browserArgs);
    const instanceViews = new InstanceViews(parts, parts, instanceStates, catalog, CORE_ICON_NAMES, ownerId);
    const liveViews = new LiveViews(hub, browser, instanceViews);
    // Every part change reaches the open views of the apps that show it
    parts.onChange((kind, name) => {
        liveViews.partChanged(kind, name).catch((error: unknown) => {
            options.report.info('Views not refreshed after a part change', { kind, name, reason: error instanceof Error ? error.message : String(error) });
        });
    });
    return {
        useCases,
        hub,
        authorities,
        calls: authorities.calls,
        liveViews,
        instanceViews,
        categoryIndex: catalog.categoryIndex(),
        presets: patterns.presets().map((name) => ({ name, summary: patterns.preset(name)?.summary ?? '' })),
        recoverParts: () => partFiles.recover(),
        browser,
        report: options.report,
        viewUrl: (appId) => `${options.origin()}/apps/${appId}`,
        ...(toolCallLog !== undefined && { toolCallLog })
    };
}
