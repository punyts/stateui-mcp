import { randomUUID } from 'node:crypto';
import { CORE_ICON_NAMES } from '@punyts/stateui-components';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';
import { createUiBuilderUseCases } from './createUiBuilder.js';
import type { UiBuilderUseCases } from './createUiBuilder.js';
import { BrowserPreview } from '../infrastructure/preview/BrowserPreview.js';
import type { PreviewBrowser } from '../infrastructure/preview/BrowserPreview.js';
import { LivePreviewLog } from '../infrastructure/preview/LivePreviewLog.js';
import { LiveViews } from '../infrastructure/preview/LiveViews.js';
import { PreviewHub } from '../infrastructure/preview/PreviewHub.js';
import { AppFolders } from '../infrastructure/storage/AppFolders.js';
import { FileUiAppRepository } from '../infrastructure/storage/FileUiAppRepository.js';
import { FileUiErrorLog } from '../infrastructure/storage/FileUiErrorLog.js';
import { FileUiFileRepository } from '../infrastructure/storage/FileUiFileRepository.js';
import { FsUiFileStore } from '../infrastructure/storage/FsUiFileStore.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import type { UiAppRepository } from '../application/ports/UiAppRepository.js';

export interface ServicesOptions {
    /** Where the apps live: one folder per app */
    readonly dataDir: string;
    readonly report: UseCaseReport;
    /** The origin the HTTP server listens on. A function, because the port may be chosen when the server starts */
    readonly origin: () => string;
    /** Replaces the Playwright browser, for tests */
    readonly browser?: PreviewBrowser;
}

/** Everything the transports need: the use cases, the live views, the browser and the repository */
export interface Services {
    readonly useCases: UiBuilderUseCases;
    readonly repository: UiAppRepository;
    readonly hub: PreviewHub;
    readonly liveViews: LiveViews;
    readonly browser: PreviewBrowser;
    readonly report: UseCaseReport;
    readonly viewUrl: (appId: string) => string;
}

/** The composition root of the server: plain factories, no container */
export function createServices(options: ServicesOptions): Services {
    const folders = new AppFolders(options.dataDir);
    const lock = new KeyedLock();
    const now = (): Date => new Date();
    const repository = new FileUiAppRepository(folders, lock, now);
    const fileRepository = new FileUiFileRepository(folders, lock, now);
    const fileStore = new FsUiFileStore(folders);
    const hub = new PreviewHub(now);
    const { validator, catalog } = createStateUiAdapters();
    const previewLog = new LivePreviewLog(hub, new FileUiErrorLog(folders, lock), fileRepository);
    const useCases = createUiBuilderUseCases(
        { repository, validator, previewLog, catalog, fileRepository, fileStore },
        { now, newId: randomUUID, report: options.report, coreIconNames: CORE_ICON_NAMES }
    );
    const browser = options.browser ?? new BrowserPreview(hub, options.origin);
    return {
        useCases,
        repository,
        hub,
        liveViews: new LiveViews(useCases.getUiApp, hub, browser),
        browser,
        report: options.report,
        viewUrl: (appId) => `${options.origin()}/apps/${appId}`
    };
}
