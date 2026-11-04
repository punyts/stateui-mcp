import { randomUUID } from 'node:crypto';
import { CORE_ICON_NAMES } from '@punyts/stateui-components';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';
import { createUiBuilderUseCases } from './createUiBuilder.js';
import type { UiBuilderUseCases } from './createUiBuilder.js';
import { BrowserPreview } from '../infrastructure/preview/BrowserPreview.js';
import type { PreviewBrowser } from '../infrastructure/preview/BrowserPreview.js';
import { HubLiveState } from '../infrastructure/preview/HubLiveState.js';
import { LivePreviewLog } from '../infrastructure/preview/LivePreviewLog.js';
import { LiveViews } from '../infrastructure/preview/LiveViews.js';
import { PreviewHub } from '../infrastructure/preview/PreviewHub.js';
import { AppFolders } from '../infrastructure/storage/AppFolders.js';
import { FileUiAppRepository } from '../infrastructure/storage/FileUiAppRepository.js';
import { FileUiErrorLog } from '../infrastructure/storage/FileUiErrorLog.js';
import { FileUiFileRepository } from '../infrastructure/storage/FileUiFileRepository.js';
import { FsUiFileStore } from '../infrastructure/storage/FsUiFileStore.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { AppAuthorities } from '../infrastructure/sync/AppAuthorities.js';
import type { AppCalls, AppProcedure } from '../infrastructure/sync/AppCalls.js';
import { FileNamespaceStorage } from '../infrastructure/sync/FileNamespaceStorage.js';
import { PersistedStates } from '../infrastructure/sync/PersistedStates.js';
import { StatenetRelayStorage } from '../infrastructure/sync/StatenetRelayStorage.js';
import type { UiAppRepository } from '../application/ports/UiAppRepository.js';

export interface ServicesOptions {
    /** Where the apps live: one folder per app */
    readonly dataDir: string;
    readonly report: UseCaseReport;
    /** The origin the HTTP server listens on. A function, because the port may be chosen when the server starts */
    readonly origin: () => string;
    /** Replaces the Playwright browser, for tests */
    readonly browser?: PreviewBrowser;
    /** The statenet's WebSocket URL; absent: the state is kept in the data folder and there are no Persisted apps */
    readonly statenet?: string;
    /** The key that encrypts `$.server` at rest */
    readonly serverKey?: Uint8Array;
    /** The server procedures Full-mode logic `call`s by name; other names wait for the agent */
    readonly procedures?: Readonly<Record<string, AppProcedure>>;
}

/** Everything the transports need: the use cases, the live views, the browser and the repository */
export interface Services {
    readonly useCases: UiBuilderUseCases;
    readonly repository: UiAppRepository;
    readonly hub: PreviewHub;
    /** The sync authority of each app: the views connect to it, the tools write through it */
    readonly authorities: AppAuthorities;
    /** The calls of Full-mode logic that wait for the agent's answer */
    readonly calls: AppCalls;
    readonly liveViews: LiveViews;
    readonly browser: PreviewBrowser;
    readonly report: UseCaseReport;
    readonly viewUrl: (appId: string) => string;
    /** Stops relaying to the statenet, after the relayed changes are acknowledged; after `authorities.close()` */
    close(): Promise<void>;
}

/** The composition root of the server: plain factories, no container */
export function createServices(options: ServicesOptions): Services {
    const folders = new AppFolders(options.dataDir);
    const lock = new KeyedLock();
    const now = (): Date => new Date();
    const hub = new PreviewHub(now);
    const relay = options.statenet === undefined ? undefined : new StatenetRelayStorage(options.statenet, options.serverKey);
    const persisted = options.statenet === undefined ? undefined : new PersistedStates(options.statenet);
    const { validator, catalog, library } = createStateUiAdapters();
    const authorities = new AppAuthorities(
        relay ?? new FileNamespaceStorage(folders),
        (appId, name, value, viewId) => {
            hub.recordEvent(appId, viewId, name, value);
            hub.touch(appId, viewId);
        },
        options.serverKey,
        { library, report: options.report, ...(options.procedures !== undefined && { procedures: options.procedures }) }
    );
    const repository = new FileUiAppRepository(folders, lock, authorities, now, randomUUID, persisted);
    const fileRepository = new FileUiFileRepository(folders, lock, now);
    const fileStore = new FsUiFileStore(folders);
    const previewLog = new LivePreviewLog(hub, new FileUiErrorLog(folders, lock), fileRepository);
    const useCases = createUiBuilderUseCases(
        { repository, validator, previewLog, catalog, fileRepository, fileStore, liveState: new HubLiveState(hub) },
        { now, newId: randomUUID, report: options.report, coreIconNames: CORE_ICON_NAMES }
    );
    const browser = options.browser ?? new BrowserPreview(hub, options.origin);
    return {
        useCases,
        repository,
        hub,
        authorities,
        calls: authorities.calls,
        liveViews: new LiveViews(useCases.getUiApp, hub, browser),
        browser,
        report: options.report,
        viewUrl: (appId) => `${options.origin()}/apps/${appId}`,
        close: async () => {
            await relay?.close();
            await persisted?.close();
        }
    };
}
